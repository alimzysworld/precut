// node-pty 1.1.0's npm macOS helper is shipped without its executable bit.
import { chmodSync, existsSync } from 'node:fs';
for (const arch of ['arm64', 'x64']) {
  const helper = `node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`;
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
