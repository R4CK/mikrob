---
name: wsl-git-push-deploy-key
description: Push a WSL repo (often on a /mnt/<drive> Windows mount) to a private GitHub repo using an SSH deploy key, when there is no gh CLI and HTTPS push has no credentials. Use when a git push fails with "could not read Username" or the user provides an SSH key path under /mnt/c.
---
# WSL git push with an SSH deploy key

## Mikor használd
- Egy repón (gyakran `/mnt/h`, `/mnt/c` Windows-mount) pushni kell privát GitHub repóba.
- A push hibázik: `fatal: could not read Username for 'https://github.com'` (nincs gh CLI, nincs token, a repo API 404 = privát).
- A user ad egy SSH (deploy) kulcsot, jellemzően `/mnt/c/Users/<USER>/.ssh/` alatt.

## Eljárás
1. Listázd a kulcsokat (a PRIVÁT kulcs tartalmát SOHA ne logold):
   `ls -la /mnt/c/Users/<USER>/.ssh/` ; a `*.pub` típusa `cut -d' ' -f1 *.pub`.
2. **Másold a privát kulcsot valódi Linux fs-re 600 joggal** (KRITIKUS, lásd Buktatók):
   ```bash
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   cp /mnt/c/Users/<USER>/.ssh/<key> ~/.ssh/<key>
   chmod 600 ~/.ssh/<key>
   ```
3. Állítsd a remote-ot SSH-ra:
   `git -C <repo> remote set-url origin git@github.com:<OWNER>/<REPO>.git`
4. Teszteld az auth-ot (csak hitelesítés, nincs shell):
   `ssh -i ~/.ssh/<key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -T git@github.com`
   Sikeres: `Hi <OWNER>/<REPO>! You've successfully authenticated...` (deploy key esetén repo-specifikus).
5. Push:
   `GIT_SSH_COMMAND='ssh -i ~/.ssh/<key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new' git -C <repo> push -u origin <branch>`
6. Perzisztáld (jövőbeli push automatikus):
   `git -C <repo> config core.sshCommand "ssh -i $HOME/.ssh/<key> -o IdentitiesOnly=yes"`

## Buktatók
- **A `/mnt/c` és `/mnt/h` fájlok jogai 777 (rwxrwxrwx).** Az SSH a túl-nyitott privát kulcsot ELUTASÍTJA ("UNPROTECTED PRIVATE KEY FILE"/bad permissions), ezért a kulcsot KÖTELEZŐ valódi Linux fs-re (`~/.ssh`) másolni 600-zal. Direktben a /mnt-ről nem megy.
- `IdentitiesOnly=yes` kell, különben az ssh-agent más kulcsait próbálja előbb és "too many authentication failures".
- Első kapcsolatnál `StrictHostKeyChecking=accept-new` (vagy a known_hosts-ba felveszi automatikusan), különben non-interaktívban elakad.
- Privát kulcs tartalmát SOHA ne írd ki (se cat, se echo).
- Repo API 404 != hiba: privát repo unauthenticated 404-et ad; a deploy key push akkor is mehet.
- `GIT_TERMINAL_PROMPT=0` a HTTPS-próbánál gyors fail-t ad (nem akad meg user/pass kéréssel).

## Ellenőrzés
- `ssh -T` "successfully authenticated" üzenet.
- `git ls-remote --heads origin` mutatja a felpushelt branchet.
- `git -C <repo> config core.sshCommand` be van állítva.
