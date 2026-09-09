/** Installed outside the repository; never downloads plaintext database data.
 * SSH host-key checking and BatchMode remain enabled. Mac sleep delays pulls. */
import { mkdirSync, chmodSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
const root = join(homedir(), 'Library/Application Support/UsurpBackups');
const archives = join(root, 'archives');
mkdirSync(archives, {recursive:true,mode:0o700});
chmodSync(root,0o700); chmodSync(archives,0o700);
const sshArgs = ['-o','BatchMode=yes','-o','ConnectTimeout=15','-p','22022','-i',join(homedir(),'Documents/trovara/trovera/OVHRSA')];
try {
  const keyPath = join(root,'backup-passphrase');
  if (!existsSync(keyPath)) {
    const key = execFileSync('/usr/bin/ssh',[...sshArgs,'ubuntu@51.210.106.93','sudo cat /opt/usurp-data/secrets/backup-passphrase'],{timeout:30000});
    if (!/^[a-f0-9]{96}\n$/.test(key.toString())) throw Error('Unexpected backup key format');
    writeFileSync(keyPath,key,{mode:0o600,flag:'wx'});
  }
  execFileSync('/usr/bin/rsync',['-az','--timeout=60','--rsync-path=sudo rsync','-e', '/usr/bin/ssh '+sshArgs.join(' '),
    '--include=*/','--include=*.dump.gpg','--include=*.dump.gpg.sha256','--include=latest-backup.json','--include=latest-restore.json','--exclude=*',
    'ubuntu@51.210.106.93:/var/backups/usurp-db/',archives+'/'],{timeout:180000,stdio:['ignore','pipe','pipe']});
  for (const file of readdirSync(archives).filter(f => f.endsWith('.dump.gpg.sha256'))) {
    const line = readFileSync(join(archives,file),'utf8').trim();
    const match = /^([a-f0-9]{64})  ([a-z0-9T.Z-]+\.dump\.gpg)$/.exec(line);
    if (!match || file !== match[2]+'.sha256') throw Error('Invalid backup checksum manifest');
    if (createHash('sha256').update(readFileSync(join(archives,match[2]))).digest('hex') !== match[1]) throw Error('Backup checksum mismatch');
  }
  if (process.argv.includes('--rehearsal')) {
    if (!readdirSync(archives).some(f => f.endsWith('.dump.gpg.sha256'))) throw Error('No rehearsal backup downloaded');
    console.log('Encrypted rehearsal backup copied and checksums verified; production backup scheduling remains disabled.');
    process.exit(0);
  }
  const report = JSON.parse(readFileSync(join(archives,'latest-backup.json'),'utf8'));
  if (!report.ok || !Number.isFinite(Date.parse(report.completedAt)) || Date.now()-Date.parse(report.completedAt)>36*3600000) throw Error('Server backup is missing or older than 36 hours');
  const restore = JSON.parse(readFileSync(join(archives,'latest-restore.json'),'utf8'));
  if (!restore.ok || !Number.isFinite(Date.parse(restore.completedAt)) || Date.now()-Date.parse(restore.completedAt)>8*24*3600000) throw Error('Restore verification failed or is overdue');
  writeFileSync(join(root,'last-pull.json'),JSON.stringify({ok:true,at:new Date().toISOString(),backup:report.file})+'\n',{mode:0o600});
  console.log('Encrypted Usurp backup copied and checksums verified.');
} catch {
  // Deliberately do not serialize subprocess errors, which can contain secrets.
  writeFileSync(join(root,'last-pull.json'),JSON.stringify({ok:false,at:new Date().toISOString()})+'\n',{mode:0o600});
  spawnSync('/usr/bin/osascript',['-e','display notification "Backup download failed or the server backup is stale. Check UsurpBackups logs." with title "Usurp backup needs attention"']);
  console.error('Usurp backup pull failed. Check SSH connectivity and the server backup service.');
  process.exitCode=1;
}
