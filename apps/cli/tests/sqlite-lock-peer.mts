import { DatabaseSync } from "node:sqlite";

const filename = process.argv[2];
if (!filename) {
  throw new Error("sqlite_lock_filename_required");
}
const database = new DatabaseSync(filename);
database.exec("BEGIN IMMEDIATE");
let released = false;
function release() {
  if (released) {
    return;
  }
  released = true;
  database.exec("ROLLBACK");
  database.close();
  if (process.connected) {
    process.disconnect();
  }
}
process.on("disconnect", release);
process.on("message", (message: unknown) => {
  if (message === "release") {
    release();
  }
});
process.send?.("locked");
