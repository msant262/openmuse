# Hermes Python cell source

Copied unchanged from NousResearch/hermes-agent revision
`e0550c97bbd916cd5ff8fa0450e6291c31921b94`, `tools/code_kernel.py`.
Source: https://github.com/NousResearch/hermes-agent/blob/e0550c97bbd916cd5ff8fa0450e6291c31921b94/tools/code_kernel.py
SHA-256: `ab88721b4a82c6b32d4160b441daccbb0e84e44c100d7bb29bcb6491a882ca5f`.
MIT license reproduced in `HERMES-LICENSE`.

The host adapter uses the original `RUNNER_CELL_SOURCE` (persistent globals,
compile/exec, exception and SystemExit behavior) and `KernelRegistry`.
It does not install Hermes or import its model/tool registry. The adapter's
private pipe replaces upstream's local socket/remote file transport. The
runner clips UTF-8 by bytes, creates private bounded spill files and binds
each tool call to its current cell. Host callbacks renew per cell and retire
on every exit, including timeout, pause and protocol failure.

This source copy alone does not establish production parity. Until native
transport and host dispatch are connected and ordinary published chats pass,
Python must not be advertised as an available execute_code language.
