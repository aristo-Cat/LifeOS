<div align="center">

<img src="https://raw.githubusercontent.com/danielmiessler/LifeOS/main/images/lifeos-logo.png" alt="LifeOS" width="200">

<br/>

# LifeOS 6.0.0

**The first release under the LifeOS name — and the whole system now ships as one self-contained skill.**

[![Skills](https://img.shields.io/badge/Skills-49-22C55E?style=flat)](../../LifeOS/install/skills/)
[![Algorithm](https://img.shields.io/badge/Algorithm-v6.23.0-D97706?style=flat)](../../LifeOS/install/LifeOS/ALGORITHM/)
[![Pulse](https://img.shields.io/badge/Pulse-included-3B82F6?style=flat)](../../LifeOS/install/LifeOS/PULSE/)
[![Install](https://img.shields.io/badge/Install-one%20line-2563EB?style=flat)](#one-line-install)

</div>

---

LifeOS is a Life Operating System. It knows your goals, the people who matter to you, and where you are right now, and it works to move you toward where you want to be. The engine underneath is a verifiable loop: turn any request into testable criteria, then climb until they pass.

This is the first release under the LifeOS name. The project was called PAI (Personal AI Infrastructure). Everything you had is still here — this version adds a cleaner way to install it.

## One-line install

```bash
curl -fsSL https://ourlifeos.ai/install.sh | bash
```

> **LifeOS is AI-native — it installs *into* your AI coding harness.** Run the one-liner in your terminal, or paste it to your AI (Claude Code) and say *"install this."* It pulls the LifeOS skill from GitHub, drops it into your harness, then hands off to **`/lifeos-setup`** — a setup *conversation* with your AI that captures your goals and wires everything with your permission. Your AI does the install for you.

That command lays down the entire system:

- The system prompt and the operating rules
- The Algorithm — the loop that turns a request into criteria you can check, and keeps going until they hold
- 49 skills
- The hook system
- Pulse, your Life Dashboard, including the observability view
- The statusline, the memory scaffold, and a USER template you fill in with your own goals and context

## What you need

- Claude Code
- bun

## Notes

- The whole system ships as a single self-contained skill (`LifeOS/`). One directory, one install.
- Nothing personal ships. The USER tree is a blank template you populate; the download is clean.
- Pulse comes up empty on a fresh install and fills in as you run the setup interview.
- New name, same system. If you ran PAI, this is the next version of it.

## Full changelog

See the commit history for the detail behind this release.
