/** Before any module that might keep a reference to `globalThis.fetch`. */
import { installSystemNetwork } from "./system-network";

installSystemNetwork();
