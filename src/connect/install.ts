/** Public command metadata only. No token, socket credential or personal CLI configuration is read. */
import { isWsl } from "../wsl-detect.js";
export function connectInstallInfo(home: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const distro = env.WSL_DISTRO_NAME && !/[\u0000-\u001f\u007f]/.test(env.WSL_DISTRO_NAME) && env.WSL_DISTRO_NAME.length <= 128 ? env.WSL_DISTRO_NAME : null;
  const args = ["connect", "--home", home];
  return {
    supported: platform !== "win32", wsl: platform === "linux" && isWsl(env), wslDistro: distro,
    local: { command: "agend", args },
    windows: distro ? { command: "wsl.exe", args: ["-d", distro, "--", "agend", ...args] } : null,
  };
}
