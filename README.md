# Slack Agent Course

The code built step by step in the "Creating Slack Agents" class on Agentic Coding School. Each
lesson ends at a git tag.

**Want a bot you can install and use?** Use
[agentic-coding-school/slack-agent-starter](https://github.com/agentic-coding-school/slack-agent-starter)
instead. It runs on Cloudflare Workers with E2B or Impello, and your coding agent sets it up for you
by following its SETUP.md.

## Lessons 5 to 15 were updated

On 6 November 2026 the code at lessons 5 to 15 changed, so it now differs slightly from the videos.
The videos show the bot pasting the first 20 messages of a thread into every prompt. Slack returns
threads oldest first, so a long thread lost its newest messages. Now the bot reads the whole thread,
sends the first message plus the newest ones on the first turn only, and leaves the rest to the Claude
Code session.

If you cloned before that date, the simplest way to get the new code is a fresh clone. To update an
existing clone, run `git fetch --force --tags origin`. Your local `main` and `lesson-XX` branches have
different history from the new ones, so `git pull` will not work on them.
