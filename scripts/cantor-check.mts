import { run } from "../src/lib/cantor/check-entry.ts";

const result = await run();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
