# Security

## What is in scope

Browser checks keep Chrome's sandbox enabled and must run without administrator privileges. If Chrome cannot start in that environment, stop and fix the environment rather than disabling its sandbox.

Anatomy is a set of instructions, a drawing kit and local Node scripts. Browser helpers use a throwaway profile and serve local pages from a temporary server bound to `127.0.0.1`. Its document root is the page's directory; paths and symlinks outside that directory are refused. Browser requests are restricted to that server. WebSockets, workers, embedded frames and objects are blocked.

To check a development server, use a loopback IP and pass its exact origin with `--allow-origin`, for example `--allow-origin http://127.0.0.1:3000`. Other origins and redirects to them remain blocked. These browser controls do not replace operating-system network isolation or guarantee that Chrome itself makes no background requests.

Build scripts, print specifications and drive actions are executable code, not safe document formats. Use only trusted inputs. The browser restrictions do not constrain Node build scripts or the assistant running them.

A security problem is anything in this repository that could let a page, a prompt or a file run code, read files or reach the network in a way the user did not ask for: in the kit, in the scripts, in the built example pages, or in instructions in `SKILL.md` and `references/` that would lead Claude to do something unsafe.

## Supported versions

Only the latest commit on `main` is supported.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub's [private vulnerability reporting](https://github.com/wheresryan22/anatomy/security/advisories/new) for this repository. If that link does not work, send a direct message to [@wheresryan22](https://x.com/wheresryan22) on X asking for a private channel, without the details.

Include what you found, how to reproduce it, and what it could let someone do.
