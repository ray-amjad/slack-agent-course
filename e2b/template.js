import { Template } from "e2b";

/**
 * Brings Postgres and Redis up inside the sandbox. Baked in as a file at build
 * time rather than inlined into setStartCmd so the logic is readable and can be
 * run by hand (`/usr/local/bin/joestar-services`) when debugging a live sandbox.
 *
 * Setting PATH is the load-bearing line, and it is why the first build of this
 * failed. E2B runs the start command with a minimal environment, and `service`
 * lives in /usr/sbin — which is not on the PATH of the sandbox's non-root
 * `user`. Without this, the script dies on "service: not found", `set -e` takes
 * it down, nothing ever listens on 5432, and the only symptom is the ready
 * check timing out ten minutes later with no hint as to why.
 *
 * `sudo` only when we aren't already root: E2B doesn't document which user the
 * start command runs as, and this works either way (the image has sudo, and it
 * is passwordless for `user`).
 *
 * The log redirect exists because a start command that fails is otherwise
 * invisible — the build just reports a ready-check timeout. `cat` that file in
 * a live sandbox and the actual error is right there.
 *
 * The trailing `exec sleep infinity` is deliberate. E2B polls the ready check
 * concurrently with a start command it expects to keep running (its own example
 * is a webserver), so a script that exits immediately after daemonizing both
 * services sits in the one case E2B's behaviour isn't specified for. Staying
 * alive keeps us on the documented path.
 */
const SERVICES_SCRIPT = `#!/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

exec >> /tmp/joestar-services.log 2>&1
set -ex

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo > /dev/null; then SUDO="sudo"; fi

$SUDO service postgresql start

# Debian's init script exits 0 even when the cluster failed to come up — it
# doesn't propagate pg_ctlcluster's exit code — so "service start" succeeding
# is not evidence of anything. Verify, and let set -e fail us loudly into the log
# if Postgres isn't actually accepting connections.
for _ in $(seq 30); do pg_isready -q && break; sleep 1; done
pg_isready

$SUDO redis-server /etc/redis/redis.conf --daemonize yes --supervised no

exec sleep infinity
`;

/**
 * One-time cluster setup, run at build time so the role and database are baked
 * into the image instead of being recreated on every sandbox start.
 *
 * The pg_hba.conf rewrite drops the cluster to `trust` for local and loopback
 * connections. That is a real loosening and it is safe only because of what
 * this sandbox is: single-tenant and unreachable from the network — Postgres
 * listens on localhost only, and anyone who can reach that port can already run
 * arbitrary code in the box (see the note in sandbox-guardrails.js). The single
 * tenant is the THREAD, not the message: the box is paused rather than
 * destroyed when a turn ends, so whatever the agent wrote into this cluster is
 * still there on the next one. That was never part of what made `trust` safe,
 * which is why the argument survives the change — but don't reach for "it's
 * gone in a minute" as a reason for anything in here.
 *
 * What it buys is that every client works with no credential dance: bare `psql`,
 * a DATABASE_URL with a password, or one without, all connect.
 *
 * Note the role is named `user` to match the sandbox's own OS user, so `psql`
 * with no arguments lands in the right place. `user` is a reserved word in SQL,
 * hence the quoting — and the reason the role is created through a heredoc
 * rather than a nest of shell-escaped -c flags.
 */
const PG_SETUP = `set -eu
CONF_DIR="$(ls -d /etc/postgresql/*/main)"

# Debian enables SSL by default, pointed at the snakeoil certificate that the
# ssl-cert package generates on install. That certificate exists during the
# build but is NOT there when a sandbox boots from the finished image, so
# Postgres dies on startup with "could not load server certificate file". It
# fails silently, too: Debian's init script still exits 0, so the only symptom
# is E2B's ready check timing out ten minutes later. Nothing here is reachable
# off-localhost, so TLS buys nothing and turning it off is the honest fix.
sed -i "s/^ssl = on/ssl = off/" "$CONF_DIR/postgresql.conf"

service postgresql start
for _ in $(seq 30); do pg_isready -q && break; sleep 1; done
pg_isready
HBA="$CONF_DIR/pg_hba.conf"
cat > "$HBA" <<'EOF'
local   all   all                 trust
host    all   all   127.0.0.1/32  trust
host    all   all   ::1/128       trust
EOF
service postgresql reload
su postgres -c "psql -v ON_ERROR_STOP=1 -q" <<'SQL'
CREATE ROLE "user" WITH LOGIN SUPERUSER PASSWORD 'postgres';
CREATE DATABASE app OWNER "user";
SQL
service postgresql stop
`;

/**
 * The sandbox image Joestar runs prompts in.
 *
 * E2B has no public "claude-code" template — this definition is the template,
 * and `npm run template:build` is what publishes it to your E2B team under the
 * name below. Until that build runs, `Sandbox.create(TEMPLATE_NAME)` 404s.
 */
export const TEMPLATE_NAME = "claude-code";

export const template = Template()
  .fromNodeImage("24")
  // git + ripgrep aren't strictly required, but Claude Code reaches for them
  // constantly and the failure mode without them is a confusing tool error.
  .aptInstall(["curl", "git", "ripgrep"])
  // The GitHub CLI, for `gh pr create` and friends. It isn't in the base image's
  // apt sources, so this adds GitHub's own repo rather than hoping `gh` resolves.
  // Nothing here needs credentials — `gh` reads GH_TOKEN from the environment at
  // run time, which is the only reason a non-interactive sandbox can use it.
  .runCmd(
    [
      "install -m 0755 -d /etc/apt/keyrings",
      "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg",
      "chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg",
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
      "apt-get update && apt-get install -y gh",
    ],
    { user: "root" },
  )
  // Installed globally so the sandbox exposes it simply as `claude`.
  .npmInstall("@anthropic-ai/claude-code@latest", { g: true })
  // Playwright, for screenshotting/recording a locally-running app (e.g. a
  // Next.js dev server) and dropping the result into /tmp/outputs. Installed
  // globally like claude-code above, purely so `npx playwright` resolves
  // without a per-run install.
  .npmInstall("playwright@latest", { g: true })
  // Bakes both the apt-level browser dependencies (--with-deps) and the
  // ~170MB Chromium + ffmpeg binaries into the image itself, at build time.
  // Without this, every run would repeat that apt-get + download before it
  // could open a page — minutes of setup for what should be instant. Only
  // Chromium: Firefox/WebKit aren't needed for local-app screenshots and
  // recordings, and skipping them keeps the image smaller and the build
  // faster.
  //
  // PLAYWRIGHT_BROWSERS_PATH is the load-bearing part. This step runs as root,
  // and Playwright installs browsers under $HOME — so without it they land in
  // /root/.cache/ms-playwright, which the sandbox's `user` can neither find nor
  // read. Playwright then greets the agent with "Executable doesn't exist at
  // /home/user/.cache/ms-playwright/..." and tells it to run `playwright
  // install`, re-downloading ~170MB at run time and defeating the point of
  // baking Chromium in at all. Installing to a shared path outside any home
  // directory fixes it for every user; lib/claude-sandbox.js passes the same
  // path into the run so Playwright looks in the right place.
  .runCmd(
    [
      "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx --yes playwright install --with-deps chromium",
      // a+rX (capital X) marks directories traversable and executables runnable
      // without making every browser data file executable.
      "chmod -R a+rX /ms-playwright",
    ],
    { user: "root" },
  )
  // Postgres and Redis, so the agent can build and actually run something that
  // needs a datastore instead of stubbing one. Both are ordinary apt packages;
  // installing postgresql also creates the "main" cluster via its postinst,
  // which is what PG_SETUP below then configures.
  .aptInstall(["postgresql", "postgresql-contrib", "redis-server"])
  .runCmd(PG_SETUP, { user: "root" })
  // One string, not an array: runCmd joins array elements with ` && `, which
  // would put the heredoc's terminator on the same line as the next command
  // (`SCRIPT && chmod …`). Bash then never sees a line containing only the
  // terminator, swallows the rest of the command into the file, and the chmod
  // silently never runs — leaving a start command that isn't executable.
  .runCmd(
    `cat > /usr/local/bin/joestar-services <<'SCRIPT'\n${SERVICES_SCRIPT}SCRIPT\nchmod +x /usr/local/bin/joestar-services`,
    { user: "root" },
  )
  // Started at sandbox boot, not per run: by the time Sandbox.create resolves,
  // both are already accepting connections. The ready check gates on both, so a
  // sandbox is never handed over with only half its datastores up. This has to
  // be the last call in the chain — setStartCmd closes the builder.
  // Absolute paths in the ready check for the same reason the script pins PATH:
  // it runs in the same minimal environment, so nothing here should depend on
  // what happens to be resolvable.
  .setStartCmd(
    "/usr/local/bin/joestar-services",
    "/usr/bin/pg_isready -q && /usr/bin/redis-cli ping > /dev/null",
  );
