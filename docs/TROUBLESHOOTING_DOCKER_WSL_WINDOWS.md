# Docker Desktop and WSL Recovery on Windows

This runbook documents a failure reproduced and repaired on July 15, 2026. It is intentionally portable so it can be copied to other Windows projects that use Docker Desktop with the WSL 2 backend.

## Incident summary

Docker Desktop was installed and its CLI existed, but the Linux engine could not start. Reinstalling Docker Desktop did not help because Docker was only the visible consumer of the broken component. The actual failure was an incomplete Windows Subsystem for Linux installation.

Observed error:

```text
running wslexec: The system cannot find the file specified.
Wsl/Service/RegisterDistro/CreateVm/HCS/ERROR_FILE_NOT_FOUND
wsl.exe --import-in-place docker-desktop ...\Docker\wsl\main\ext4.vhdx
exit status 0xffffffff
```

The WSL CLI still appeared healthy:

```powershell
wsl.exe --status
wsl.exe --version
```

That output was misleading. It proved that `wsl.exe` and `wslservice` existed, but not that WSL could create a version 2 virtual machine.

## Root cause

Two WSL runtime images were missing:

```text
C:\Program Files\WSL\system.vhd
C:\Program Files\WSL\tools\modules.vhd
```

Without them, Host Compute Service (HCS) could not create the lightweight WSL 2 VM used by Docker Desktop. Docker consequently failed while registering its internal `docker-desktop` distribution.

This is a WSL installation/update failure, not a Docker image, Compose, project, PostgreSQL, or VPN configuration error. Reinstalling Docker does not necessarily reinstall or repair these WSL files.

Related upstream reports:

- <https://github.com/microsoft/WSL/issues/40488>
- <https://github.com/microsoft/WSL/issues/11162>
- <https://github.com/microsoft/WSL/discussions/40318>

## Fast diagnosis

Run the following in PowerShell:

```powershell
docker info
wsl.exe --status
wsl.exe --version
wsl.exe --list --verbose

Test-Path "C:\Program Files\WSL\system.vhd"
Test-Path "C:\Program Files\WSL\tools\modules.vhd"
```

This incident is a strong match when all of the following are true:

1. `docker info` prints the client section but the server says Docker Desktop is unable to start.
2. Docker logs contain `RegisterDistro/CreateVm/HCS/ERROR_FILE_NOT_FOUND`.
3. WSL status/version commands work, but WSL cannot start or register a WSL 2 distribution.
4. Either `Test-Path` command returns `False`.

Docker's backend log is normally located at:

```text
%LOCALAPPDATA%\Docker\log\host\com.docker.backend.exe.log
```

Useful log query:

```powershell
$log = "$env:LOCALAPPDATA\Docker\log\host\com.docker.backend.exe.log"
Select-String -Path $log -Pattern "RegisterDistro|CreateVm|HCS/|wslErrorCode" |
  Select-Object -Last 30
```

## Confirmed repair

Use an elevated PowerShell window. Match the MSI version to the installed WSL version shown by `wsl.exe --version`.

The version repaired in this incident was WSL `2.7.10.0`:

```powershell
wsl.exe --shutdown

$msi = "$env:TEMP\wsl.2.7.10.0.x64.msi"

Invoke-WebRequest `
  -Uri "https://github.com/microsoft/WSL/releases/download/2.7.10/wsl.2.7.10.0.x64.msi" `
  -OutFile $msi

Start-Process msiexec.exe `
  -ArgumentList "/fa `"$msi`" /passive /norestart" `
  -Wait
```

`/fa` forces Windows Installer to restore all WSL files. Verify before rebooting:

```powershell
Test-Path "C:\Program Files\WSL\system.vhd"
Test-Path "C:\Program Files\WSL\tools\modules.vhd"
```

Both commands must return `True`. Then restart Windows:

```powershell
Restart-Computer
```

After restart, open Docker Desktop and verify both engine access and container execution:

```powershell
docker info
docker run --rm hello-world
```

Success criteria:

- `docker info` contains a `Server` section with engine details.
- `hello-world` downloads and prints `Hello from Docker!`.

## Safe fallback order

If the forced MSI repair does not restore both VHD files:

1. Run `wsl.exe --update --web-download`, then `wsl.exe --shutdown` and reboot.
2. In Windows Settings, use **Apps > Installed apps > Windows Subsystem for Linux > Advanced options > Repair**. Do not choose Reset unless WSL distribution loss is acceptable.
3. Repair WSL using the matching official MSI again and inspect the installer log.
4. If the current WSL release is affected by a known regression, install a previously confirmed working official WSL MSI. Upstream users with the same missing-VHD symptom reported success with WSL 2.6.3.
5. Only after WSL itself can create a VM should Docker Desktop be repaired or reinstalled.

Avoid these destructive actions until data is backed up:

```text
wsl.exe --unregister <distribution>
Docker Desktop factory reset
Deleting Docker/WSL VHDX files
Deleting Docker volumes or bind-mount directories
```

## Why common attempts did not work

- **Reinstalling Docker Desktop:** the missing files belonged to WSL under `C:\Program Files\WSL`, not to the project or a container.
- **Starting/stopping `com.docker.service`:** the Windows service could run while HCS still lacked the WSL runtime images.
- **Replacing Docker's internal `ext4.vhdx`:** Docker generated a new disk, but HCS failed before it could boot it.
- **Changing `.wslconfig`:** default and mirrored networking modes failed identically because VM creation occurs before normal container networking.
- **Disabling Proton VPN:** VPN filters can affect DNS and routing after Docker starts, but they do not explain missing WSL system VHD files.
- **Checking only `wsl --status`:** this validates CLI/service metadata, not creation of a WSL 2 VM.

## Prevention and normal shutdown guidance

Normal Windows sleep does not require closing Docker Desktop every time. Docker Desktop and WSL are designed to survive ordinary sleep/resume cycles. The incident evidence points to an incomplete WSL installation/update, not to routine sleep itself.

Use these practices:

### Normal short sleep

- It is normally safe to leave Docker Desktop running.
- Save editor and database work as usual.
- After resume, run `docker info` only if Docker appears unavailable.

### Planned Windows restart, shutdown, or update

For this project, gracefully stop Compose services first:

```powershell
pnpm.cmd db:down
```

Then quit Docker Desktop from its tray menu. This gives PostgreSQL a clean shutdown and reduces recovery work after boot. It is a precaution, not a mandatory requirement for every restart.

If WSL itself was updated, let the installer finish. Do not force power-off or close the machine during `wsl --update`, MSI installation, Windows Update, or a requested reboot.

### Forced power-off or unstable machine

- Avoid forced shutdown while Docker, PostgreSQL, Windows Update, or a WSL installer is writing data.
- After an unexpected power loss, start Docker and check `docker compose ps` plus container logs before modifying files.
- PostgreSQL may perform automatic WAL recovery; allow its health check to become healthy before running Prisma.

### Periodic checks

After a WSL or Windows feature update:

```powershell
wsl.exe --version
Test-Path "C:\Program Files\WSL\system.vhd"
Test-Path "C:\Program Files\WSL\tools\modules.vhd"
docker info
```

Keep project data in reproducible Compose definitions and bind mounts or named volumes. Docker documents backup and recovery options at <https://docs.docker.com/desktop/settings-and-maintenance/backup-and-restore/>.

## Secondary issue found after Docker recovery: Prisma P1001

After Docker was repaired, PostgreSQL was healthy and port `5433` was open, but Prisma still reported:

```text
P1001: Can't reach database server at localhost:5433
```

The direct database query succeeded. `localhost` resolved to IPv6 `::1`, while the effective Docker connection was available through IPv4. Prisma did not successfully fall back.

Confirmed fix:

```dotenv
DATABASE_URL="postgresql://pm_dev:pm_dev_password@127.0.0.1:5433/property_manager?schema=public"
```

Diagnostic distinction:

- If `docker info` has no working server section, repair Docker/WSL first.
- If Docker works and PostgreSQL is healthy but Prisma reports P1001, test `127.0.0.1` before changing credentials, migrations, or database contents.

## Property Manager recovery verification

The complete recovery for this repository was verified with:

```powershell
pnpm.cmd db:up
pnpm.cmd --dir apps/api exec prisma migrate deploy
pnpm.cmd --dir apps/api exec prisma generate
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd build
```

Results on July 15, 2026:

- PostgreSQL and Redis healthy.
- All 9 Prisma migrations applied.
- Prisma Client generated.
- 84 tests passed.
- Typecheck passed.
- API and web production builds passed.

