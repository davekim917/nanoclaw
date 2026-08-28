interface DockerInstruction {
  name: string;
  value: string;
}

interface DockerArgDeclaration {
  value: string | undefined;
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

function finalRunConsumerIndex(instructions: DockerInstruction[], consumingText: string): number {
  for (let index = instructions.length - 1; index >= 0; index -= 1) {
    const instruction = instructions[index];
    if (instruction.name === 'RUN' && instruction.value.includes(consumingText)) return index;
  }
  return -1;
}

function dockerArgDeclaration(value: string, name: string): DockerArgDeclaration | undefined {
  const match = value.match(new RegExp(`^${name}(?:=([^\\s#]+))?\\s*$`));
  return match === null ? undefined : { value: match[1] };
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

function lastDockerArg(instructions: DockerInstruction[], name: string): string | undefined {
  let effective: string | undefined;
  for (const instruction of instructions) {
    if (instruction.name !== 'ARG') continue;
    const declaration = dockerArgDeclaration(instruction.value, name);
    if (declaration?.value !== undefined) effective = declaration.value;
  }
  return effective;
}

/** Whether a real, uncommented RUN instruction consumes the pinned package text. */
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

  const globalValue = lastGlobalDockerArg(instructions, name);
  let effective: string | undefined;
  let redeclared = false;
  for (const instruction of instructions.slice(stageStart + 1, consumerIndex)) {
    if (instruction.name !== 'ARG') continue;
    const declaration = dockerArgDeclaration(instruction.value, name);
    if (declaration === undefined) continue;
    redeclared = true;
    effective = declaration.value ?? globalValue;
  }
  return redeclared ? effective : undefined;
}

/** Return the final ARG declaration for diagnostics when no consuming RUN exists. */
export function finalDockerArg(dockerfile: string, name: string): string | undefined {
  return lastDockerArg(parseDockerInstructions(dockerfile), name);
}
