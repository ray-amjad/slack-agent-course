import { Template, defaultBuildLogger } from "e2b";

import { template, TEMPLATE_NAME } from "./template.js";

if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is not set. Grab one at https://e2b.dev/dashboard");
  process.exit(1);
}

// 4GB rather than 2: the image now runs Postgres and Redis as resident daemons
// alongside whatever the agent starts itself, and Chromium alone can take most
// of a 2GB box. E2B bills by sandbox lifetime and size, so this is a real (if
// small) cost increase — drop it back if runs turn out not to need the room.
await Template.build(template, TEMPLATE_NAME, {
  cpuCount: 2,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
});

console.log(`\nBuilt template "${TEMPLATE_NAME}".`);
