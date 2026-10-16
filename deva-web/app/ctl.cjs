// src/web-server/ctl.ts
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_os = require("node:os");
function devaHome() {
  const o = process.env.DEVA_HOME?.trim();
  return o && o.length > 0 ? o : (0, import_node_path.join)((0, import_node_os.homedir)(), ".deva");
}
var authPath = (0, import_node_path.join)(devaHome(), "web-auth.json");
function load() {
  try {
    return JSON.parse((0, import_node_fs.readFileSync)(authPath, "utf8"));
  } catch {
    console.error(`\u51ED\u636E\u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u635F\u574F\uFF1A${authPath}
\u5148\u542F\u52A8\u4E00\u6B21 deva-web \u4EE5\u521D\u59CB\u5316\u3002`);
    process.exit(1);
  }
}
function save(auth) {
  const tmp = `${authPath}.tmp-${Date.now()}`;
  (0, import_node_fs.writeFileSync)(tmp, JSON.stringify(auth, null, 2), { mode: 384 });
  (0, import_node_fs.renameSync)(tmp, authPath);
}
function genPassword() {
  const sets = ["abcdefghijkmnpqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!@#$%^&*-_=+?"];
  const all = sets.join("");
  const buf = (0, import_node_crypto.randomBytes)(64);
  let i = 0;
  const next = () => buf[i++ % buf.length];
  let out = "";
  for (const s of sets) out += s[next() % s.length];
  while (out.length < 20) out += all[next() % all.length];
  return out;
}
var [cmd, ...rest] = process.argv.slice(2);
if (cmd === "passwd") {
  const auth = load();
  const pw = rest[0] && rest[0].length > 0 ? rest[0] : genPassword();
  if (pw.length < 8) {
    console.error("\u5BC6\u7801\u81F3\u5C11 8 \u4F4D");
    process.exit(1);
  }
  const salt = (0, import_node_crypto.randomBytes)(16).toString("hex");
  auth.salt = salt;
  auth.hash = (0, import_node_crypto.scryptSync)(pw, Buffer.from(salt, "hex"), 64).toString("hex");
  auth.secret = (0, import_node_crypto.randomBytes)(32).toString("hex");
  save(auth);
  console.log(`\u5DF2\u91CD\u7F6E\u5BC6\u7801\uFF08\u7528\u6237\u540D ${auth.user}\uFF09\u3002\u6240\u6709\u65E7\u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u7528\u65B0\u5BC6\u7801\u91CD\u65B0\u767B\u5F55\u3002`);
  if (!rest[0]) console.log(`\u65B0\u5BC6\u7801\uFF1A${pw}`);
} else if (cmd === "user") {
  const auth = load();
  if (!rest[0]) {
    console.error("\u7528\u6CD5\uFF1Actl.cjs user <\u7528\u6237\u540D>");
    process.exit(1);
  }
  auth.user = rest[0];
  save(auth);
  console.log(`\u7528\u6237\u540D\u5DF2\u6539\u4E3A ${rest[0]}\uFF08\u65E7\u767B\u5F55\u7684 cookie \u4ECD\u6709\u6548\u2014\u2014\u4F1A\u8BDD\u4E0D\u4EE5\u7528\u6237\u540D\u4E3A\u51ED\u636E\uFF09`);
} else if (cmd === "info") {
  const auth = load();
  console.log(`\u51ED\u636E\u6587\u4EF6\uFF1A${authPath}`);
  console.log(`\u7528\u6237\u540D\uFF1A${auth.user}`);
  console.log(`\u521D\u59CB\u5BC6\u7801\u6587\u4EF6\uFF1A${(0, import_node_path.join)(devaHome(), "web-login.txt")}\uFF08\u5B58\u5728\u5219\u6709\u521D\u59CB\u5BC6\u7801\uFF1B\u91CD\u7F6E\u540E\u5E94\u5220\u9664\uFF09`);
} else {
  console.log(`Deva Web \u7BA1\u7406\u5DE5\u5177

\u7528\u6CD5\uFF1A
  node out/web/ctl.cjs passwd [\u5BC6\u7801]   \u91CD\u7F6E\u7BA1\u7406\u5458\u5BC6\u7801\uFF08\u7701\u7565\u5BC6\u7801\u5219\u968F\u673A\u751F\u6210\u5E76\u6253\u5370\uFF09
  node out/web/ctl.cjs user <\u7528\u6237\u540D>   \u4FEE\u6539\u7BA1\u7406\u5458\u7528\u6237\u540D
  node out/web/ctl.cjs info            \u67E5\u770B\u51ED\u636E\u4FE1\u606F\uFF08\u4E0D\u542B\u5BC6\u7801\uFF09
`);
}
