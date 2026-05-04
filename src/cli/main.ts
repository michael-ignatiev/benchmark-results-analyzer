#!/usr/bin/env node
import { runCli } from "./run.js";

const exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
});

process.exitCode = exitCode;
