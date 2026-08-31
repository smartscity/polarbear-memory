#!/usr/bin/env node
import { installSqliteExperimentalWarningFilter } from "./runtime/sqlite-warning-filter.js";

installSqliteExperimentalWarningFilter();
await import("./cli-main.js");
