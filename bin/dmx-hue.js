#!/usr/bin/env node
import { DmxHue } from "../index.js";
const cli = new DmxHue(process.argv.slice(2));
cli.run().catch(async (error) => {
  console.error(error.message);
  await cli.stop();
  process.exitCode = 1;
});
