# NixOS notes: whole-disk search and mounted drives

Two things make NixCast feel like it searches "everywhere": a plocate database
for names across the whole machine, and mounted drives that are actually visible
when the index is built. Both are system-level setup, which is why they live in
their own document.

Neither is required. Without them, search covers `~/Downloads`, `~/Desktop`,
`~/Documents`, recently used files, browser history and bookmarks — which is
most of what a launcher is asked for.

---

## 1. Whole-disk name search (plocate)

plocate keeps a prebuilt database of every path on the machine, so a lookup
costs about ten milliseconds instead of a filesystem walk. NixCast consults it
**only when the in-memory index has no confident match**, so typing never pays
for it.

Enable it:

```nix
# configuration.nix
services.locate.enable = true;
```

```bash
sudo nixos-rebuild switch
sudo systemctl start update-locatedb     # build /var/cache/locatedb now
systemctl list-timers update-locatedb    # it also runs on a timer
```

Check that NixCast sees it:

```bash
cd ~/nixcast/brain && bun run src/index.js --check
# plocate       : /run/current-system/sw/bin/plocate
```

### Things that go wrong

* **`/var/cache/locatedb: No such file or directory`** — the database has not
  been built yet. `services.locate.enable` installs the timer; the first build
  only happens when the service runs, so start it explicitly as above.
* **A drive's files never turn up in a name search** — plocate only knows what
  existed when the database was last built. After mounting a drive, run
  `sudo systemctl start update-locatedb`. The live walk (below) covers the file
  in the meantime.
* **The database is large.** It is a snapshot of every path; on a machine with
  several drives, a rebuild takes a few seconds. That is the trade for searches
  that do not care which drive a file is on.
* **`PRUNEFS` in `/etc/updatedb.conf`.** NixOS prunes `fuse` filesystems, which
  sounds like it would exclude NTFS drives mounted with `ntfs-3g` — but those
  appear as `fuseblk`, which is *not* in the list. If you add `fuseblk` to
  `PRUNEFS` yourself, name search stops seeing those drives.

To tell NixCast about a folder *without* a whole-disk database — one that comes
and goes, or that you would rather not scan globally — put it in
`index.searchRoots` instead. That is section 4.

---

## 2. Mounting a drive so it is always there

The goal: the drive is mounted when it is present, NixCast can search it, and
**a missing drive does not stop the machine from booting**.

```nix
# configuration.nix
fileSystems."/mnt/onedrive" = {
  device = "/dev/disk/by-uuid/XXXXXXXXXXXXXXXX";
  fsType = "ntfs3";
  options = [
    "rw"
    "nofail"                        # a missing drive is not a boot failure
    "x-systemd.device-timeout=5s"   # and does not stall the boot for 90s
    "nosuid"
    "nodev"
    "uid=1000"
    "gid=100"
    "iocharset=utf8"
    "umask=022"
  ];
};
```

Find the UUID with `lsblk -f` or `blkid`, and prefer the `UUID=` form over
`/dev/sdX`: device names move, UUIDs do not.

### ntfs3 or ntfs-3g?

* `ntfs3` is the in-kernel driver. Fast, no extra package.
* `ntfs-3g` is FUSE-based and more forgiving.

This matters after Windows has been shut down mid-write: the volume is marked
dirty, and Linux refuses it.

```
ntfs3(nvme0n1p4): volume is dirty and "force" flag is not set!
mount: /mnt/d-drive: wrong fs type, bad option, bad superblock
```

**Do not add `force`.** Clear the flag instead:

```bash
sudo ntfsfix -d /dev/nvme0n1p4     # this one works for the dirty flag
sudo mount /mnt/d-drive            # verify by hand before trusting fstab
```

On this machine `chkdsk D: /f` from Windows did **not** clear it; `ntfsfix -d`
did. Either is safe; neither is the same as forcing a mount.

### Checking a mount

```bash
findmnt /mnt/d-drive               # mounted? by which driver?
ls /mnt/d-drive
```

Two NixOS quirks that cost time:

* **The unit name escapes dashes.** `/mnt/d-drive` becomes
  `mnt-d\x2ddrive.mount`. `systemctl status mnt-d-drive.mount` reports *"Unit
  could not be found"* — that is a typo, not a missing mount. Use
  `findmnt`, or quote the real name:
  `systemctl status 'mnt-d\x2ddrive.mount'`.
* **`nofail` means exactly that.** Nothing warns you when the drive is absent;
  `bun run src/index.js --check` lists each configured root as present or
  `(missing — skipped)`.

---

## 3. Symlinks into your home directory

Mount points under `/mnt` are awkward to type and to keep in a config file. Link
them into `~/mnt` with `systemd.tmpfiles` so they exist at every boot and are
recreated if a mount replaces them:

```nix
systemd.tmpfiles.rules = [
  "d /home/ritam/mnt 0755 ritam users -"
  "L+ /home/ritam/mnt/onedrive - - - - /mnt/onedrive"
  "L+ /home/ritam/mnt/d-drive - - - - /mnt/d-drive"
];
```

`L+` is the important part: it removes and recreates the symlink, so it survives
a drive being unmounted and remounted. `d` creates the directory it lives in.

With that, `~/mnt/onedrive` and `~/mnt/d-drive` are stable paths for your config
and for anything you type by hand.

---

## 4. Teaching NixCast about those drives

Indexing a drive's whole tree up front is the wrong trade: the index becomes
slow to build and stale as soon as the drive is unplugged. List it as a **search
root** instead — it is walked on demand, only when the index has nothing
confident, and a root that is not mounted is simply skipped.

```jsonc
// ~/.config/nixcast/config.json
{
  "index": {
    "searchRoots": [
      "/home/ritam/mnt/onedrive/Users/Admin/OneDrive/Pictures",
      "/home/ritam/mnt/d-drive/D DRIVE HP LAPTOP"
    ],
    "liveWalk": { "enabled": true, "maxDepth": 6, "timeoutMs": 120 }
  }
}
```

Notes:

* Point these at the **symlinks**, not at `/mnt/...`, so both spellings of your
  setup keep working and the config reads like your home directory.
* `maxDepth` keeps a walk from descending into a deep tree; `timeoutMs` is a
  hard deadline, so partial results are normal and fine.
* To *index* a folder instead — searches in it are frequent and it is not
  removable — add it to `index.extraDirs` rather than `searchRoots`.
* After mounting a new drive, `sudo systemctl start update-locatedb` if you want
  plocate to see it too.

Verify:

```bash
cd ~/nixcast/brain && bun run src/index.js --check
# search roots  :
#                /home/ritam/mnt/onedrive/.../Pictures
#                /home/ritam/mnt/d-drive/D DRIVE HP LAPTOP
```

Then, in the panel, type a filename you know is on the drive. It should appear
with `On disk` in the subtitle and open with Enter.
