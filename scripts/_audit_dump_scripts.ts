import fs from 'node:fs';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('usage: tsx scripts/_audit_dump_scripts.ts <scan-out.json>');
  console.error('(input is the JSON produced by scripts/_audit_scan_tasks.ts)');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as Array<{
  group: string;
  session: string;
  row: { id: string; series_id: string | null; content: string };
}>;

for (const item of data) {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(item.row.content);
  } catch {
    console.log(`=== ${item.group} / ${item.row.series_id} — UNPARSEABLE CONTENT ===`);
    continue;
  }
  const script = typeof content.script === 'string' ? content.script : null;
  console.log(
    `=== group=${item.group} series=${item.row.series_id} id=${item.row.id} scriptHost=${content.scriptHost} hasScript=${!!script} ===`,
  );
  if (script) {
    console.log(script);
  }
  console.log('');
}
