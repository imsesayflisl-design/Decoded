# Product Requirements Document — Decoded

> **Decoded** — a VS Code extension that explains your errors to teach you, right where you code.

| | |
|---|---|
| **Product** | Decoded (VS Code extension) |
| **Author** | Idriss M. Sesay |
| **Version** | 2.0 |
| **Status** | Draft — for cohort review |
| **Last updated** | June 2026 |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Objectives & Success Metrics](#2-objectives--success-metrics)
3. [Target Users & Personas](#3-target-users--personas)
4. [Scope](#4-scope)
5. [User Stories](#5-user-stories)
6. [Functional Requirements](#6-functional-requirements)
7. [The Teaching Output Specification](#7-the-teaching-output-specification)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Assumptions & Dependencies](#9-assumptions--dependencies)
10. [Risks](#10-risks)
11. [Glossary](#11-glossary)

---

## 1. Overview

### 1.1 Summary
Decoded is a Visual Studio Code extension. When you hit an error, you trigger Decoded and it explains that error in four parts — what it means, why it's happening in your code, how to fix it, and how to avoid it next time — in a panel beside your editor. It reads the error and the surrounding code directly from VS Code, so there is nothing to copy and paste.

### 1.2 Problem
The habit that separates developers who get unstuck quickly from those who stall is the ability to *read* an error instead of fearing it. Beginners change things at random, or paste the error into a separate chat and copy back a fix without understanding the cause — and switching out of the editor to do it adds friction every time. Decoded lives where the errors already are and is built to teach, not just to patch.

### 1.3 Vision
You see a red squiggle, press a shortcut, and Decoded turns it into a lesson — inside your editor, tied to your actual code — so you understand it and the same mistake stops catching you out.

---

## 2. Objectives & Success Metrics

| # | Objective | Success metric |
|---|---|---|
| O1 | Explain errors without leaving the editor | Triggering on an error returns the four-part answer in a panel, no copy-paste |
| O2 | Make the cause specific | The "why" references the user's actual code or the diagnostic, not a generic definition |
| O3 | Keep answers consistent | 100% of answers contain all four parts, in order |
| O4 | Feel native to VS Code | Triggerable via command, lightbulb, right-click, and a keybinding; the panel matches the active theme |
| O5 | Demo reliably end to end | Squiggle → explain → four-part panel, plus reopening from history, without failure |

---

## 3. Target Users & Personas

| Persona | Description | Primary need |
|---|---|---|
| **Junior / self-taught developer** *(primary)* | Codes in VS Code; gets stuck on errors | Understand the error enough to fix it without guessing |
| **Cohort / bootcamp student** | Learning to debug | Build the habit of reading errors properly |
| **Busy developer** | Wants a fast, clear breakdown | A focused explanation in-editor, not a trip to a browser |

---

## 4. Scope

### 4.1 In scope (v1)
- Explain an error taken from either the **diagnostic at the cursor** (the squiggle a language server reports) or **selected text**.
- Automatically include the relevant **code context** and the file's language.
- A four-part explanation rendered in a **Webview panel** that matches the VS Code theme.
- Store the **Anthropic API key securely** (VS Code SecretStorage) via a command.
- A **local history** of past explanations, reopenable from a sidebar view.

### 4.2 Out of scope (v1)
- A web app, user accounts, or a cloud database.
- Automatically rewriting the user's code (Decoded shows the fix; applying it is the user's choice — auto-apply is a stretch goal).
- Whole-project or multi-file analysis.
- Editors other than VS Code.

---

## 5. User Stories

- **US1** — As a developer, I see a red squiggle, press a shortcut, and Decoded explains it in a side panel, tied to that line.
- **US2** — As a developer, I select an error message (e.g. from the terminal or output) and have Decoded explain it.
- **US3** — As a learner, I see *why* it broke in my own code.
- **US4** — As a developer, I see the corrected code beside my broken line.
- **US5** — As a learner, I get a rule for avoiding the error next time.
- **US6** — As a returning user, I reopen a past explanation from a Decoded view in the sidebar.
- **US7** — As a user, I set my API key once, stored securely, and never think about it again.

---

## 6. Functional Requirements

| ID | Requirement | Acceptance criterion |
|---|---|---|
| **FR-1** | Explain command | "Decoded: Explain Error" is available in the Command Palette. |
| **FR-2** | Read from diagnostic | When a diagnostic exists at the cursor, its message is used as the error. |
| **FR-3** | Read from selection | When text is selected (and no diagnostic applies), the selection is used as the error. |
| **FR-4** | Gather context | The relevant code (the error's line plus a few surrounding lines, or the selection) and the document's language are collected automatically. |
| **FR-5** | Four-part explanation | Every response returns all four parts (§7), in order. |
| **FR-6** | Themed panel | The explanation renders in a Webview panel with syntax-highlighted code and a before/after fix, matching the active VS Code theme. |
| **FR-7** | Lightbulb action | A Code Action ("Explain with Decoded") appears on a diagnostic and runs the explain flow for it. |
| **FR-8** | Context menu & keybinding | A right-click editor menu item and a configurable keybinding trigger Decoded. |
| **FR-9** | Set API key | "Decoded: Set API Key" stores the key in VS Code SecretStorage. |
| **FR-10** | Missing-key handling | If no key is set, the user is prompted to set one before the call. |
| **FR-11** | Local history | Each explanation is saved locally; a sidebar view lists them; opening one re-renders it in the panel. |
| **FR-12** *(stretch)* | Apply fix | A button inserts the corrected code into the file. |
| **FR-13** *(stretch)* | Terminal error | Explain the last error in the terminal via shell integration. |

---

## 7. The Teaching Output Specification

This is the heart of the product. **Consistency is the value** — the same four parts appear every time, in this order, following a deliberate **words → code → words → code** rhythm.

| Part | Must contain | Must avoid |
|---|---|---|
| **1. What it means** | The error in plain English (1–3 sentences) **followed by** the exact line or snippet it points to, shown as formatted code. | Jargon dumps; explanations with no code anchor. |
| **2. Why it's happening** | The likely cause in the user's specific case, referencing their actual code where available. | A generic textbook definition; a list of ten possible causes. |
| **3. How to fix it** | Numbered steps **and** a corrected snippet shown beside the broken one. | A full rewrite; an unexplained change. |
| **4. How to avoid it next time** | One practical habit or rule that prevents this whole class of error. | A restatement of the fix; vague advice. |

This structure is a deliberate teaching-design decision, not just an output format, and it is what makes Decoded different from a general chat assistant.

---

## 8. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| **NFR-1** | Consistency | The four-part structure is produced for every supported language, every time. |
| **NFR-2** | Performance | An explanation returns within a few seconds under normal conditions. |
| **NFR-3** | Reliability | API failures and missing input are handled gracefully in the panel, never with an unhandled crash. |
| **NFR-4** | Security | The API key is stored in VS Code SecretStorage — never in settings, code, or logs. |
| **NFR-5** | Privacy | Only the error and the relevant code snippet are sent to the AI provider to produce the explanation; history stays on the user's machine. |
| **NFR-6** | Native UX | The Webview honours VS Code theme variables and a strict Content-Security-Policy; commands and keybindings follow VS Code conventions. |

---

## 9. Assumptions & Dependencies

- The product depends on the **VS Code Extension API** and an **LLM API** (Anthropic — see the Implementation Plan for model and key).
- An internet connection is required for the explanation call.
- Explanation quality is best when a diagnostic or a clear selection identifies the error; included code context improves it.
- Runs on VS Code (desktop).

---

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Model returns an inconsistent structure | Breaks the core promise | Strict prompt + JSON output + Zod validation + one retry |
| No diagnostic and no selection | Nothing to explain | Clear message asking the user to select an error or place the cursor on a squiggle |
| API key mishandled | Security risk | Store in SecretStorage; never log or expose it |
| Webview theming / CSP pitfalls | Broken or unstyled panel | Use VS Code theme variables and a strict CSP from the start |
| Scope creep (auto-fix, terminal parsing) | Misses the deadline | Keep FR-12 / FR-13 as stretch only |

---

## 11. Glossary

- **Extension** — software that adds features to VS Code.
- **Diagnostic** — a problem (error/warning) a language server reports, shown as a squiggle and in the Problems panel.
- **Code Action / lightbulb** — the contextual quick-fix menu VS Code shows on a line.
- **Webview** — a custom HTML panel an extension can render inside VS Code.
- **SecretStorage** — VS Code's secure, per-user store for sensitive values like API keys.
- **globalState** — VS Code's simple key-value store an extension uses to persist data (used here for history).
- **VSIX** — the packaged extension file you install or publish.
- **MVP** — Minimum Viable Product; the smallest version that delivers the core value and can be demoed.
