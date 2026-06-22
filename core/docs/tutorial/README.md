---
sidebar_label: Overview
---

# Tutorial

Tutorials are step-by-step walkthroughs that take you from zero to a working result.
Each one focuses on a concrete scenario and explains every decision along the way.

Unlike the [Guides](../guides/README.md), tutorials are not reference material —
they are learning exercises. Follow them in order, run the code, and observe what
happens.

---

## Available tutorials

### [Request Scope with Fastify](./request-scope-fastify.md)

Wire DiCaf's request scope into a Fastify application. You will build a container
that creates a fresh `RequestContext` per HTTP request and makes it available to
any service that depends on it.

**What you will learn:**

- Setting up DiCaf with stage 3 decorators
- Binding services across singleton and request scopes
- Integrating the request scope lifecycle with Fastify hooks
- Writing isolated tests for request-scoped components

**Prerequisites:** Node.js ≥ 20, TypeScript 5+, basic familiarity with Fastify.
