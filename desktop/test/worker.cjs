if (!process.env.CONNECT_TEST_FIXTURES) throw new Error("Missing fixture path");
require("node:os").homedir = () => process.env.CONNECT_TEST_FIXTURES;
const fs = require("node:fs");
const marker = require("node:path").join(process.env.CONNECT_TEST_FIXTURES, "fail-next-upload");
const fetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url).endsWith("/v1/ingest") && fs.existsSync(marker)) { fs.unlinkSync(marker); throw new TypeError("Synthetic offline test"); }
  return fetch(url, options);
};
require("../dist/sync-worker.cjs");
