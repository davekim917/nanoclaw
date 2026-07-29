import path from 'path';

export interface GraphifySystemdUnitOptions {
  projectRoot: string;
  nodePath: string;
  homeDir: string;
  installTarget: 'default.target' | 'multi-user.target';
  /** System units may drop privileges. User units must leave these unset. */
  user?: string;
  group?: string;
}

/**
 * Derive the background indexer's unit from the checkout-scoped host unit.
 * Keeping the host unit intact avoids collisions between parallel installs.
 */
export function getGraphifySystemdUnit(mainUnitName: string): string {
  return `${mainUnitName}-graphify`;
}

function systemdToken(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Render the Graphify daemon's systemd unit without touching the filesystem.
 *
 * The daemon is deliberately lower priority than interactive NanoClaw work.
 * Its write surface is restricted to derived graph state, logs, Codex state,
 * an isolated temporary directory, and the Docker control socket used to run
 * bounded extraction workers. Codex authentication is read from the protected
 * home tree; each semantic job gets a separate writable ephemeral home.
 */
export function renderGraphifySystemdUnit(options: GraphifySystemdUnitOptions): string {
  const { projectRoot, nodePath, homeDir, installTarget, user, group } = options;
  const serviceIdentity = [
    ...(user ? [`User=${user}`] : []),
    ...(group ? [`Group=${group}`] : []),
    ...(user && group ? ['SupplementaryGroups=docker'] : []),
  ];
  const executable = path.join(projectRoot, 'dist', 'graphify-daemon', 'index.js');

  return `[Unit]
Description=NanoClaw Graphify Workgroup Knowledge Daemon
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
${serviceIdentity.length > 0 ? `${serviceIdentity.join('\n')}\n` : ''}ExecStart=${systemdToken(nodePath)} ${systemdToken(executable)}
WorkingDirectory=${systemdToken(projectRoot)}
Restart=on-failure
RestartSec=10s
TimeoutStopSec=30s
KillMode=control-group

# Scheduled indexing must yield host resources to interactive agent turns.
Nice=10
CPUWeight=10
IOWeight=10
OOMScoreAdjust=500
# The hot set is the active workgroup graph plus the shared enrichment DB
# (~4G today). Below that, the cgroup cannot cache enough of the SQLite files,
# so the kernel swaps the daemon's anonymous pages and the control-socket
# thread stalls in D-state — every graphify query then misses its 30s deadline.
MemoryHigh=4G
MemoryMax=6G

Environment=HOME=${systemdToken(homeDir)}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin:${homeDir}/.npm-global/bin
StandardOutput=append:${systemdToken(path.join(projectRoot, 'logs', 'graphify-daemon.log'))}
StandardError=append:${systemdToken(path.join(projectRoot, 'logs', 'graphify-daemon.error.log'))}
UMask=0077

# The daemon reads workgroup sources, but only derived state and logs are mutable.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
ReadWritePaths=${systemdToken(path.join(projectRoot, 'data'))}
ReadWritePaths=${systemdToken(path.join(projectRoot, 'logs'))}
ReadWritePaths=-/run/docker.sock
ReadWritePaths=-/var/run/docker.sock
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native

[Install]
WantedBy=${installTarget}`;
}
