#!/bin/bash
# Offline image integration check. Pass a candidate image built with the wrapper.
# No production state or credentials are mounted; inference uses a fake CLI.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${1:?usage: claude-review-wrapper.test.sh candidate-image}
docker run --rm --network none -i --entrypoint bun \
  -v "$ROOT/container/agent-runner/src:/app/src:ro" "$IMAGE" - <<'TEST'
import fs from 'node:fs';
import { startClaudeReviewService } from '/app/src/cli/claude-review-service.ts';
const versions = [];
for (const bin of ['/pnpm/claude', '/usr/local/bin/claude', '/pnpm/claude-real']) {
  const child = Bun.spawn([bin, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  versions.push(await new Response(child.stdout).text());
  if (await child.exited !== 0) throw new Error('version passthrough failed');
}
if (new Set(versions).size !== 1) throw new Error('original CLI differs from wrapper');
const fake = '/tmp/claude-review-fake';
fs.writeFileSync(fake, `#!${process.execPath}
const input=await Bun.stdin.text();
if(input!=='review smoke 日本語\\n') process.exit(9);
const failed=process.env.CLAUDE_CODE_OAUTH_TOKEN!=='fake-healthy';
console.log(JSON.stringify({type:'result',is_error:failed,result:failed?"You've hit your session limit · resets 2:40pm (America/New_York)":'review completed',usage:{input_tokens:0,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0},modelUsage:{}}));
process.exit(failed?1:0);
`, { mode: 0o700 });
const service = await startClaudeReviewService({executable:fake,getEnv:()=>({PATH:process.env.PATH,CLAUDE_CODE_OAUTH_TOKEN:'fake-limited',CLAUDE_CODE_OAUTH_TOKEN_2:'fake-healthy'})});
try {
  const child = Bun.spawn(['/bin/bash','-lc','claude -p --model claude-fable-5-1 --effort high --safe-mode --no-session-persistence --permission-mode plan --tools "" --strict-mcp-config --output-format json'], {
    env:{PATH:process.env.PATH,HOME:'/home/node',NANOCLAW_CLAUDE_REVIEW_SOCKET:service.socketPath},
    stdin:new Blob(['review smoke 日本語\n']), stdout:'pipe', stderr:'pipe',
  });
  const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code!==0 || JSON.parse(out).result!=='review completed' || !err.includes('CLAUDE_CODE_OAUTH_TOKEN_2') || err.includes('fake-')) throw new Error('sanitized-client rotation failed');
  console.log('PASS: pinned CLI passthrough and login-shell review rotation with a sanitized client');
} finally { await service.stop(); }
TEST
# Missing runner source is a launcher failure, never ordinary CLI passthrough.
docker run --rm --network none --entrypoint /bin/sh "$IMAGE" -c '
  output=$(/pnpm/claude --version 2>&1)
  code=$?
  test "$code" -eq 2 || exit 1
  case "$output" in
    *"claude review launcher: unavailable"*) echo "PASS: missing launcher source fails explicitly" ;;
    *) exit 1 ;;
  esac
'
