interface DockerInstruction {
  name: string;
  value: string;
}

interface DockerArgDeclaration {
  value: string | undefined;
}

interface DockerStage {
  start: number;
  end: number;
  base: string;
  alias: string | undefined;
}

function stripShellComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      if (quote === character) quote = undefined;
      else if (quote === undefined) quote = character;
      continue;
    }
    if (character === '#' && quote === undefined && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function withoutContinuation(line: string): { value: string; continues: boolean } {
  const trimmed = line.trimEnd();
  return trimmed.endsWith('\\')
    ? { value: trimmed.slice(0, -1).trimEnd(), continues: true }
    : { value: trimmed, continues: false };
}

/** Parse the Docker instructions relevant to version pins without treating comments as code. */
export function parseDockerInstructions(dockerfile: string): DockerInstruction[] {
  const instructions: DockerInstruction[] = [];
  let current: DockerInstruction | undefined;

  const finish = (): void => {
    if (current !== undefined) instructions.push(current);
    current = undefined;
  };

  for (const physicalLine of dockerfile.split(/\r?\n/)) {
    const uncommented = stripShellComment(physicalLine);
    if (uncommented.trim() === '') continue;

    const { value, continues } = withoutContinuation(uncommented);
    if (current !== undefined) {
      current.value += ` ${value.trim()}`;
      if (!continues) finish();
      continue;
    }

    const match = value.match(/^\s*([A-Za-z]+)\b\s*(.*)$/);
    if (match === null) continue;
    current = { name: match[1].toUpperCase(), value: match[2] };
    if (!continues) finish();
  }

  finish();
  return instructions;
}

function splitShellCommands(value: string): string[] {
  const commands: string[] = [];
  let quote: '"' | "'" | undefined;
  let commandStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      if (quote === character) quote = undefined;
      else if (quote === undefined) quote = character;
      continue;
    }
    if (quote !== undefined) continue;
    if (character === ';' || character === '|') {
      commands.push(value.slice(commandStart, index));
      if (character === '|' && value[index + 1] === '|') index += 1;
      commandStart = index + 1;
    } else if (character === '&' && value[index + 1] === '&') {
      commands.push(value.slice(commandStart, index));
      index += 1;
      commandStart = index + 1;
    }
  }
  commands.push(value.slice(commandStart));
  return commands;
}

function shellTokens(value: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;

  const finish = (): void => {
    if (token !== '') tokens.push(token);
    token = '';
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\') {
      if (index + 1 < value.length) token += value[index + 1];
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      if (quote === character) quote = undefined;
      else if (quote === undefined) quote = character;
      else token += character;
      continue;
    }
    if (quote === undefined && /\s/.test(character)) {
      finish();
      continue;
    }
    token += character;
  }
  finish();
  return tokens;
}

function normalizedShellToken(value: string): string | undefined {
  const tokens = shellTokens(value);
  return tokens.length === 1 ? tokens[0] : undefined;
}

function isGlobalPackageInstall(command: string, consumingText: string): boolean {
  const tokens = shellTokens(command);
  while (tokens[0]?.startsWith('--')) tokens.shift(); // Docker RUN flags.
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift();

  const packageManager = tokens.shift();
  const verb = tokens.shift();
  if (!['pnpm', 'npm', 'bun'].includes(packageManager ?? '') || !['install', 'add'].includes(verb ?? '')) {
    return false;
  }

  const packageToken = normalizedShellToken(consumingText);
  return (
    packageToken !== undefined &&
    tokens.some((token) => token === '-g' || token === '--global' || token.startsWith('--global=')) &&
    tokens.includes(packageToken)
  );
}

function finalRunConsumerIndex(instructions: DockerInstruction[], consumingText: string): number {
  for (let index = instructions.length - 1; index >= 0; index -= 1) {
    const instruction = instructions[index];
    if (instruction.name !== 'RUN') continue;
    if (splitShellCommands(instruction.value).some((command) => isGlobalPackageInstall(command, consumingText))) {
      return index;
    }
  }
  return -1;
}

function dockerArgDeclaration(value: string, name: string): DockerArgDeclaration | undefined {
  const match = value.match(new RegExp(`^${name}(?:=([^\\s#]+))?\\s*$`));
  return match === null ? undefined : { value: match[1] };
}

function dockerEnvShadowsArg(value: string, name: string): boolean {
  return new RegExp('(?:^|\\s)' + name + '=').test(value) || new RegExp('^' + name + '\\s+').test(value);
}

function lastGlobalDockerArg(instructions: DockerInstruction[], name: string): string | undefined {
  const firstStage = instructions.findIndex((instruction) => instruction.name === 'FROM');
  if (firstStage < 0) return undefined;

  let effective: string | undefined;
  for (const instruction of instructions.slice(0, firstStage)) {
    if (instruction.name !== 'ARG') continue;
    const declaration = dockerArgDeclaration(instruction.value, name);
    if (declaration?.value !== undefined) effective = declaration.value;
  }
  return effective;
}

function finalConsumerStageStart(instructions: DockerInstruction[], consumerIndex: number): number {
  for (let index = consumerIndex - 1; index >= 0; index -= 1) {
    if (instructions[index].name === 'FROM') return index;
  }
  return -1;
}

function dockerStages(instructions: DockerInstruction[]): DockerStage[] {
  const starts = instructions
    .map((instruction, index) => (instruction.name === 'FROM' ? index : -1))
    .filter((index) => index >= 0);

  return starts.flatMap((start, index): DockerStage[] => {
    const tokens = instructions[start].value.trim().split(/\s+/);
    while (tokens[0]?.startsWith('--')) tokens.shift();
    const base = tokens.shift();
    if (base === undefined) return [];
    const alias = tokens[0]?.toUpperCase() === 'AS' ? tokens[1]?.toLowerCase() : undefined;
    return [{ start, end: starts[index + 1] ?? instructions.length, base, alias }];
  });
}

function stageAt(stages: DockerStage[], instructionIndex: number): DockerStage | undefined {
  return stages.find((stage) => stage.start < instructionIndex && instructionIndex < stage.end);
}

function namedParentStage(stages: DockerStage[], stage: DockerStage): DockerStage | undefined {
  return stages.find((candidate) => candidate.alias === stage.base.toLowerCase() && candidate.start < stage.start);
}

function inheritedEnvShadowsArg(
  instructions: DockerInstruction[],
  stages: DockerStage[],
  stage: DockerStage,
  name: string,
  seen = new Set<number>(),
): boolean | undefined {
  if (seen.has(stage.start)) return undefined;
  seen.add(stage.start);

  let shadowed = false;
  const parent = namedParentStage(stages, stage);
  if (parent !== undefined) {
    const inherited = inheritedEnvShadowsArg(instructions, stages, parent, name, seen);
    if (inherited === undefined) return undefined;
    shadowed = inherited;
  } else if (/\$[{(]?/.test(stage.base)) {
    // An ARG-expanded base may resolve to a named stage or an image with an
    // unknown ENV. Do not certify a pin when that lineage cannot be traced.
    return undefined;
  }

  for (const instruction of instructions.slice(stage.start + 1, stage.end)) {
    if (instruction.name === 'ENV' && dockerEnvShadowsArg(instruction.value, name)) shadowed = true;
  }
  return shadowed;
}

function inheritedEnvForStage(
  instructions: DockerInstruction[],
  stages: DockerStage[],
  stage: DockerStage,
  name: string,
): boolean | undefined {
  const parent = namedParentStage(stages, stage);
  if (parent !== undefined) return inheritedEnvShadowsArg(instructions, stages, parent, name);
  return /\$[{(]?/.test(stage.base) ? undefined : false;
}

function lastDockerArg(instructions: DockerInstruction[], name: string): string | undefined {
  let effective: string | undefined;
  for (const instruction of instructions) {
    if (instruction.name !== 'ARG') continue;
    const declaration = dockerArgDeclaration(instruction.value, name);
    if (declaration?.value !== undefined) effective = declaration.value;
  }
  return effective;
}

/** Whether a real global pnpm/npm/bun install consumes the pinned package text. */
export function hasDockerRunConsumer(dockerfile: string, consumingText: string): boolean {
  return finalRunConsumerIndex(parseDockerInstructions(dockerfile), consumingText) >= 0;
}

/**
 * Return the ARG value visible to the final real RUN instruction that consumes
 * the pinned package. Docker ARG values are stage-scoped: a global default is
 * usable in a stage only after that stage redeclares the ARG.
 */
export function effectiveDockerArgBeforeFinalRun(
  dockerfile: string,
  name: string,
  consumingText: string,
): string | undefined {
  const instructions = parseDockerInstructions(dockerfile);
  const consumerIndex = finalRunConsumerIndex(instructions, consumingText);
  if (consumerIndex < 0) return undefined;

  const stageStart = finalConsumerStageStart(instructions, consumerIndex);
  if (stageStart < 0) return undefined;

  const stages = dockerStages(instructions);
  const consumingStage = stageAt(stages, consumerIndex);
  if (consumingStage === undefined) return undefined;
  const inheritedShadow = inheritedEnvForStage(instructions, stages, consumingStage, name);
  if (inheritedShadow === undefined) return undefined;

  const globalValue = lastGlobalDockerArg(instructions, name);
  let effective: string | undefined;
  let redeclared = false;
  let shadowedByEnv = inheritedShadow;
  for (const instruction of instructions.slice(stageStart + 1, consumerIndex)) {
    if (instruction.name === 'ENV' && dockerEnvShadowsArg(instruction.value, name)) shadowedByEnv = true;
    if (instruction.name === 'ARG') {
      const declaration = dockerArgDeclaration(instruction.value, name);
      if (declaration === undefined) continue;
      redeclared = true;
      effective = declaration.value ?? globalValue;
    }
  }
  return redeclared && !shadowedByEnv ? effective : undefined;
}

/** Return the final ARG declaration for diagnostics when no consuming RUN exists. */
export function finalDockerArg(dockerfile: string, name: string): string | undefined {
  return lastDockerArg(parseDockerInstructions(dockerfile), name);
}
