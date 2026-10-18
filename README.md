# context-gc 🧹

**Automatically trims your Pi's context before every run — so each session starts clean, faster, and cheaper. Without ever changing a word you or the assistant wrote.**

---

## 🤔 The problem

As a Pi user, your conversation history fills up fast. Every command output, file read, and build result is stored — and a big chunk of that is **wasted**:

- The same tool output copied several times
- A file read twice, when only the *latest* version matters
- A 10,000-line build log, when you only needed the first line

That junk eats your **context window** and burns **tokens**, and it makes the assistant start each session distracted by noise.

## ✅ The solution

**context-gc** is a small, free, local Pi extension that silently trims that waste. At the start of each session it removes the tool output that is duplicated, outdated, or too large — and nothing else.

### What you get

| Benefit | Why it matters |
| --- | --- |
| 💸 **Saves tokens & cost** | Removes duplicated and outdated output before the first call of each run. |
| ⚡ **Faster, sharper responses** | The assistant starts with clean, relevant context instead of noise. |
| 🪄 **Works automatically** | Runs once per session. No manual work, no settings to babysit. |
| 🛡️ **100% safe** | Never edits or deletes your messages, files, or chat history — it only cleans *tool output*. |
| 🔒 **Private** | Runs entirely on your machine. Nothing leaves your computer. |
| 🆓 **Free & open source** | MIT licensed. |

## 🧠 How it works

context-gc is a **local** extension. It doesn't send anything anywhere — it only looks at what's already in your current session.

At the start of each run, it trims the *tool output* (the results of commands, file reads, and builds) that is:

- **Duplicated** — identical results that appear more than once.
- **Outdated** — a read of a file that was changed later (only the latest read is kept).
- **Too large** — a giant output is collapsed to its first lines + last lines, with the middle replaced by a short placeholder. Nothing important is lost.

It adapts its aggressiveness to how full your context window is — the fuller it is, the more it trims. If anything looks sensitive (like a secret), it **redacts it in place** and logs it for review instead of deleting it.

> 💡 It only touches *tool output*. Everything you say, and everything the assistant says, stays exactly as it is.

## 🚀 Install it (30 seconds)

1. Create the extensions folder (if it doesn't exist) and download the extension:

   ```bash
   mkdir -p ~/.pi/agent/extensions
   curl -fsSL https://github.com/SandroPasqual/context-gc/raw/main/src/context-gc.ts \
     -o ~/.pi/agent/extensions/context-gc.ts
   ```

2. **Reload or restart Pi.** context-gc registers itself automatically — there's nothing else to configure.

3. Done. From now on, every session starts with a clean context.

> Prefer to clone the repo?
> ```bash
> git clone https://github.com/SandroPasqual/context-gc.git
> cp context-gc/src/context-gc.ts ~/.pi/agent/extensions/context-gc.ts
> ```

## ⚙️ Configuration (optional)

By default, context-gc just works. It exposes a few knobs for those who want more control (aggressiveness thresholds, logging, rotation of the quarantine log). See the [architecture docs](docs/architecture.md).

Set `CONTEXT_GC_NO_LOG=1` in your environment to silence the info log (useful for CI or a quiet install).

## ❓ FAQ

**Is it safe? Does it delete anything?**
No. context-gc only modifies a *copy* of the tool output in your current context. Your session, messages, and files are never changed.

**Does it use the network or send my data anywhere?**
No. It runs entirely on your machine and only reads what's already in your Pi session.

**Will it slow down Pi or change my responses?**
It runs once at the start of a session and is very lightweight. By giving the model cleaner context, it can only help responses.

**Can I turn it off?**
Sure — just delete the file:
```bash
rm ~/.pi/agent/extensions/context-gc.ts
```

## 🧑‍💻 For contributors

We welcome contributions!

```bash
git clone https://github.com/SandroPasqual/context-gc.git
cd context-gc
npm install
npm run check   # typecheck + tests
npm test
```

See [docs/architecture.md](docs/architecture.md) for how it works internally.

## 📄 License

Released under the [MIT License](LICENSE).

---

Made with care for the Pi community. [⭐ Star it](https://github.com/SandroPasqual/context-gc) if it saves you tokens!
