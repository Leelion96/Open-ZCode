import { PRODUCT_USER_DIRECTORY } from "@zcode/shared/product";
import { homedir } from "node:os";
import { join } from "node:path";

export function getDefaultSessionDbPath(): string {
  return join(homedir(), PRODUCT_USER_DIRECTORY, "cli", "db", "db.sqlite");
}
