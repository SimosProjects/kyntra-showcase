# ADR 0049: PostgreSQL on a small Azure VM instead of Flexible Server

Status: accepted

Edited for outside readers. Resource names, addresses, the network layout and the names of scripts and templates
are removed. The decision and its reasoning are unchanged.

## Context

An earlier decision put the database on Azure Database for PostgreSQL Flexible Server, Burstable tier. Azure would
not offer Burstable Flexible Servers to the subscription in any region: the VM family behind that tier was not
available to it anywhere. The smallest General Purpose server costs about $150 a month, three times the whole
monthly budget of $50. Everything else stays on Azure.

## Decision

PostgreSQL 17 with PostGIS runs on one small Arm VM (2 vCPU, 4 GB, Ubuntu Server 24.04 LTS) inside the existing
virtual network, set up at first boot by cloud-init. The size is one parameter.

| Part | Choice |
| --- | --- |
| Disks | A separate data disk for `/var/lib/postgresql`, kept when the VM is deleted, so the OS can be rebuilt without touching the data |
| Network | Its own subnet. The security group allows PostgreSQL only from the App Service subnet and denies everything else inbound, SSH included |
| Going out | A public address used only for outbound updates and backups. No inbound rule uses it. A NAT gateway would cost about $33 a month |
| Software | PostgreSQL 17, PostGIS 3 and pgBackRest from PostgreSQL's apt repository, its signing key checked by fingerprint |
| Backups | pgBackRest to a private blob container, authorized with the VM's managed identity. Point in time restore to any moment of the last 7 days |
| Updates | unattended-upgrades on Sunday night, reboot only when an update needs it |
| Admin access | Azure's run-command (no open port), and the serial console for emergencies |

### Security model

- **No inbound access from the internet.** The public address exists only for going out. The subnet's security
  group replaces Azure's default rules that let in the whole virtual network.
- **No SSH.** Azure needs a public key for a Linux VM, so the setup makes one and deletes the private key at once.
  Maintenance goes through run-command, which is logged in the activity log.
- **Standard security type, not Trusted Launch.** Azure refuses Trusted Launch on the small Arm sizes. The trade-off
  is boot-level protection (secure boot and vTPM). With no inbound access at all and no SSH, reaching the boot chain
  needs control of the subscription, which also gives everything else. Moving to a size with Trusted Launch is one
  parameter.
- **Encryption at rest** with Azure's platform-managed keys on the disks and the storage account. Customer-managed
  keys would not protect against anything this setup is exposed to.
- **TLS that the API verifies.** The setup makes a private CA and a wildcard certificate for the private DNS zone.
  The CA's key exists only while the setup runs and is deleted before it returns, so nothing can sign another
  certificate. The API connects with `SSL Mode=VerifyFull` and trusts that CA only, not the system store. The
  wildcard lets a restored copy answer with the same certificate, so a restore only changes the host name.
- **Two roles.** A migrator role that owns the database and is not a superuser, and an app role with data rights
  only. `pg_hba.conf` allows TCP only over TLS, only to the app database, only for those two roles, only from the App
  Service subnet, with SCRAM. The superuser is reachable only through the local socket.
- **Secrets** stay in Key Vault. The VM's identity can read only the four secrets it needs, not the vault. No
  secret is in cloud-init, the templates or the deployment history.

### Backups and point in time restore

- **pgBackRest**, because its Azure repository authorizes with managed identities, so no storage key exists (the
  storage account has shared key access off).
- **A full backup every night** and continuous WAL archiving, with `archive_timeout = 300`, so at most 5 minutes are
  lost when traffic is low. A daily full is chosen over the usual weekly full because the database is small and it
  bounds how long deleted data stays in backups.
- **Retention by time, 7 days.** With soft delete on the container for 7 more days, a deleted account leaves the
  backups within 15 days, which is what the privacy policy says. The ids of deleted accounts are kept a day longer,
  so a restore from the oldest backup deletes those accounts again.
- **Geo-redundant storage** copies the backups to the paired region. A regional restore also needs a VM there, and
  the runbook lists the steps.
- **Restore** makes a new VM from the same template in restore mode, replays to a point in time, sets the role
  passwords from Key Vault and starts its own backups under its own path. A restore test does the same with a
  read-only role, checks the copy and deletes it.

### Tuning for 4 GB

| Setting | Value | Why |
| --- | --- | --- |
| `shared_buffers` | 1 GB | A quarter of memory, the usual start |
| `effective_cache_size` | 3 GB | What the OS can cache on top |
| `work_mem` | 8 MB | 100 connections at worst use 800 MB for sorts |
| `maintenance_work_mem` | 256 MB | Faster index builds in migrations |
| `max_connections` | 100 | One App Service instance with Npgsql's default pool, plus the migrator |
| `random_page_cost`, `effective_io_concurrency` | 1.1, 200 | SSD |
| `wal_compression`, `max_wal_size`, `checkpoint_timeout` | lz4, 2 GB, 15 min | Fewer, smaller WAL files and checkpoints |
| Swap | 1 GB file, `vm.swappiness = 10` | A safety net against a spike, not extra memory |

### Monitoring

Platform metric alerts for the VM's availability, CPU credits and memory. The VM also sends one status row every 15
minutes to Log Analytics with its managed identity: PostgreSQL up, WAL archiving failing, minutes since the last
archived WAL, hours since the last backup, data disk use and days left on the certificate. Two log alerts read the
latest row: one for backups (no backup in 26 hours, archiving failing, PostgreSQL down, or no row in an hour) and
one for the data disk above 75%.

## Cost

About $45 a month at list prices for the whole hosting, the VM about $22 of it. Under the $50 budget.

## When to move to a managed database

- Paying users, or an uptime promise: one VM has no standby, and a host failure means a restore.
- The database work takes real time every month: upgrades, restores, tuning or alerts.
- Load the VM cannot carry, or a size whose price passes General Purpose Flexible Server's.
- Azure offers Burstable Flexible Server to the subscription again. The move is a dump and restore.

## Consequences

- One VM, no high availability. The Sunday update reboot is a minute or two of downtime when an update needs it.
- The operator owns the database: updates are automatic, but major upgrades, disk growth and restores are runbook
  steps.
- B-series CPU credits: sustained load drops the VM to its base rate. The credits alert says when to resize.
