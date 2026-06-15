# Phone access: HTTPS + password (nginx basic auth + Let's Encrypt via DuckDNS)

Goal: browse the dashboard from your phone at `https://YOURNAME.duckdns.org`
behind a username/password, with a real TLS cert (no browser warnings).

nginx becomes the **only** public door. The reporter binds `127.0.0.1:8000`
and is unreachable from the internet; bots keep POSTing to localhost.

Prereqs: the reporter is already deployed and running (Part A in README.md),
and you have `sudo` on the VPS (`botuser@54.73.26.217`).

---

## 1. Get a free DuckDNS hostname

1. Go to <https://www.duckdns.org> and sign in (GitHub / Google — no signup form).
2. Type a subdomain (e.g. `lukequant`) and click **add domain** → you now own
   `lukequant.duckdns.org`.
3. In the **current ip** box for that domain, enter `54.73.26.217` and click
   **update ip**. (Verify from your laptop: `nslookup lukequant.duckdns.org`
   should return the VPS IP.)

Optional but recommended if the VPS IP is *not* static (so DNS self-heals after
a reboot) — install the 5‑minute updater on the VPS (token is on your DuckDNS page):

```bash
mkdir -p ~/duckdns
echo 'echo url="https://www.duckdns.org/update?domains=YOURNAME&token=YOUR_TOKEN&ip=" | curl -k -o ~/duckdns/duck.log -K -' > ~/duckdns/duck.sh
chmod 700 ~/duckdns/duck.sh
( crontab -l 2>/dev/null; echo "*/5 * * * * ~/duckdns/duck.sh >/dev/null 2>&1" ) | crontab -
~/duckdns/duck.sh && cat ~/duckdns/duck.log   # should print: OK
```

## 2. Open the firewall (AWS security group)

Add inbound rules to the instance's security group:

- **TCP 80** from `0.0.0.0/0` — needed for the Let's Encrypt HTTP‑01 challenge
  and the HTTP→HTTPS redirect.
- **TCP 443** from `0.0.0.0/0` — the actual HTTPS access.
- **Keep TCP 8000 CLOSED** (do not expose it). nginx reaches the app over
  localhost; the public never touches 8000.

## 3. Bind the reporter to localhost

Pull the repo and install the hardened unit (binds `127.0.0.1`):

```bash
cd ~/quant-reporter && git pull
sudo cp deploy/quant-reporter.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart quant-reporter
curl -s localhost:8000/api/bots >/dev/null && echo "reporter up on localhost"
```

(The SSH tunnel still works against this binding, so you lose nothing.)

## 4. Install nginx, the password tool, and certbot

```bash
sudo apt update
sudo apt install -y nginx apache2-utils certbot python3-certbot-nginx
```

## 5. Create the phone login (username + password)

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-quant luke   # prompts for a password
# add more users later WITHOUT -c:  sudo htpasswd /etc/nginx/.htpasswd-quant alice
```

## 6. Install the site config

```bash
sudo cp ~/quant-reporter/deploy/nginx-quant-reporter.conf \
        /etc/nginx/sites-available/quant-reporter
sudo sed -i 's/YOURNAME.duckdns.org/lukequant.duckdns.org/' \
        /etc/nginx/sites-available/quant-reporter      # <-- your real host
sudo ln -sf /etc/nginx/sites-available/quant-reporter \
        /etc/nginx/sites-enabled/quant-reporter
sudo rm -f /etc/nginx/sites-enabled/default            # drop the welcome page
sudo nginx -t && sudo systemctl reload nginx
```

At this point `http://lukequant.duckdns.org` should prompt for the password and
then show the dashboard (still plain HTTP — next step adds TLS).

## 7. Get the TLS certificate

```bash
sudo certbot --nginx -d lukequant.duckdns.org
```

certbot obtains the cert, rewrites the nginx block to add the `443` server and
an HTTP→HTTPS redirect (your `auth_basic` lines are preserved), and installs an
auto‑renewal timer. Verify renewal works:

```bash
sudo certbot renew --dry-run
```

## 8. Done — open it on your phone

Browse to **`https://lukequant.duckdns.org`** → padlock, password prompt, dashboard.

---

## Notes / troubleshooting

- **Password change:** re-run `sudo htpasswd /etc/nginx/.htpasswd-quant luke`
  then `sudo systemctl reload nginx`. No cert/nginx-config change needed.
- **502 Bad Gateway:** the reporter isn't up on 127.0.0.1:8000 — `systemctl
  status quant-reporter`.
- **Cert won't issue:** almost always DNS or port 80 — confirm
  `nslookup lukequant.duckdns.org` returns 54.73.26.217 and that TCP 80 is open
  in the security group.
- **Re-pulling the repo** won't clobber your live TLS config (certbot edited the
  copy under `/etc/nginx/`, not the repo file). If you ever re-`cp` the repo
  config over it, just re-run `sudo certbot --nginx -d lukequant.duckdns.org`.
- This only protects the dashboard. The bot ingest key (`REPORTER_API_KEY`) is a
  separate concern and still lives in `/etc/quant-reporter.env`.
