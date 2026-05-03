import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

export interface GitMetadata {
  branchName?: string;
  commitSha?: string;
}

export type ExecFile = (
  file: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string }>;

const execFile = promisify(nodeExecFile);

export async function collectGitMetadata(
  cwd: string,
  runExecFile: ExecFile = execFile,
): Promise<GitMetadata> {
  const [branchName, commitSha] = await Promise.all([
    readGitValue(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], runExecFile),
    readGitValue(cwd, ["rev-parse", "HEAD"], runExecFile),
  ]);
  const metadata: GitMetadata = {};

  if (branchName !== undefined && branchName !== "HEAD") {
    metadata.branchName = branchName;
  }

  if (commitSha !== undefined) {
    metadata.commitSha = commitSha;
  }

  return metadata;
}

async function readGitValue(
  cwd: string,
  args: string[],
  runExecFile: ExecFile,
): Promise<string | undefined> {
  try {
    const result = await runExecFile("git", args, { cwd });
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
