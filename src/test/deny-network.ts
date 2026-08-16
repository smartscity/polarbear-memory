import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

function denied(): never {
  throw new Error("Network access is denied by the Polarbear Memory offline test.");
}

Object.assign(net, { connect: denied, createConnection: denied });
Object.assign(tls, { connect: denied });
Object.assign(http, { request: denied, get: denied });
Object.assign(https, { request: denied, get: denied });
Object.assign(dns, { lookup: denied, resolve: denied });
Object.defineProperty(globalThis, "fetch", { value: denied, configurable: true, writable: false });
