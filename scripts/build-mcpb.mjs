// Расширение для Claude Desktop под текущую платформу: dist + зависимости этой ОС → protokolist-<os>-<arch>.mcpb
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const plat = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
const dir = "build/mcpb";
rmSync("build", { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const p of ["dist", "LICENSE", "README.md"]) cpSync(p, `${dir}/${p}`, { recursive: true });
cpSync("docs/img/icon.png", `${dir}/icon.png`);
const m = JSON.parse(readFileSync("mcpb/manifest.json", "utf8"));
m.version = pkg.version;
m.compatibility.platforms = [process.platform];
writeFileSync(`${dir}/manifest.json`, JSON.stringify(m, null, 2));
writeFileSync(`${dir}/package.json`, JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", license: pkg.license, dependencies: pkg.dependencies }, null, 2));
// со скриптами установки: ffmpeg-static скачивает бинарник под эту ОС
execSync("npm install --omit=dev --no-audit --no-fund", { cwd: dir, stdio: "inherit" });
// убираем бинарники чужих платформ и CUDA (Vulkan покрывает видеокарты NVIDIA, AMD, Intel)
const nm = `${dir}/node_modules`;
const keepSherpa = `sherpa-onnx-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
for (const d of readdirSync(nm)) if (d.startsWith("sherpa-onnx-") && d !== "sherpa-onnx-node" && d !== keepSherpa) rmSync(`${nm}/${d}`, { recursive: true, force: true });
try { for (const d of readdirSync(`${nm}/@node-llama-cpp`)) if (!d.startsWith(plat === "mac" ? "mac" : plat) || d.includes("cuda")) rmSync(`${nm}/@node-llama-cpp/${d}`, { recursive: true, force: true }); } catch {}
execSync(`npx -y @anthropic-ai/mcpb validate ${dir}/manifest.json`, { stdio: "inherit" });
execSync(`npx -y @anthropic-ai/mcpb pack ${dir} build/protokolist-${plat}-${process.arch}.mcpb`, { stdio: "inherit" });
