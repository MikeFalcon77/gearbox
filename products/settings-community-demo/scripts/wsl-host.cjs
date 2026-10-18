"use strict";
const fs = require("node:fs"),
  cp = require("node:child_process");
function checkVolume(volume, command) {
  const minimum = (command === "prepare" ? 20 : 4) * 1024 ** 3;
  if (
    !/^[A-Z]$/.test(volume?.drive) ||
    !Number.isFinite(volume.free) ||
    volume.free < 0
  )
    throw Error("Cannot determine the physical Windows volume backing WSL");
  if (volume.free < minimum)
    throw Error(
      `WSL host volume ${volume.drive}: has less than ${minimum / 1024 ** 3} GiB free. Free host disk space before ${command}; free space inside the VHD is insufficient evidence.`,
    );
}
function readOnlyRoot(mounts) {
  return mounts.split("\n").some((line) => {
    const fields = line.split(" ");
    return fields[1] === "/" && fields[3]?.split(",").includes("ro");
  });
}
function checkWslHost(machine, command) {
  if (machine.host !== "wsl") return;
  if (
    process.platform === "linux" &&
    readOnlyRoot(fs.readFileSync("/proc/mounts", "utf8"))
  )
    throw Error(
      "The WSL root filesystem is read-only. Restore host disk space and recover Ubuntu before deploying.",
    );
  const powershell =
    process.platform === "win32"
      ? "powershell.exe"
      : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const query =
    "$ErrorActionPreference='Stop'; $name=$env:GEARBOX_DEMO_WSL_DISTRIBUTION; $distro=Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss | ForEach-Object {Get-ItemProperty $_.PSPath} | Where-Object DistributionName -eq $name; if (@($distro).Count -ne 1 -or $distro.BasePath -notmatch '^[A-Za-z]:') {throw 'Cannot identify the WSL host volume'}; $letter=$distro.BasePath.Substring(0,1).ToUpperInvariant(); $volume=Get-PSDrive -Name $letter; [Console]::Out.Write((@{drive=$letter;free=[double]$volume.Free}|ConvertTo-Json -Compress))";
  const result = cp.spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", query],
    {
      env: {
        ...process.env,
        GEARBOX_DEMO_WSL_DISTRIBUTION: machine.distribution || "Ubuntu",
      },
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    },
  );
  if (result.status !== 0)
    throw Error(
      "Cannot check physical Windows disk space for WSL; restore the host before deploying",
    );
  checkVolume(JSON.parse(result.stdout.trim().replace(/^\uFEFF/, "")), command);
}
module.exports = { checkWslHost, checkVolume, readOnlyRoot };
