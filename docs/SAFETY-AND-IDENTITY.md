# Staying Safe & Verifying Who You're Talking To

Vanish is anonymous and end-to-end encrypted, but a few things are worth
understanding so you can trust *who* you're actually talking to. This guide is
for everyday users — no crypto background needed.

## The invite link is the room

Anyone who has the invite link can read everything in the room, post under any
name, and re-share the link. The link's secret lives only in your browser and
in the part of the URL after `#`, which browsers never send to the server.

- Share invite links only with people you trust, and only over a channel you
  trust (in person, or another secure app).
- If a link leaks, anyone who has it can join. Delete the room (if you're the
  owner) or move everyone to a new room to cut off access.

## Display names are NOT proof of identity

A display name is just a label someone typed. **The server does not verify it,
and anyone in the room can choose any name** — including one that matches
someone else's. Never trust a name on its own.

What you *can* trust is Vanish's per-message signing:

- Every message is signed on the sender's device with a key that never leaves
  it. Vanish remembers each person's key the first time it sees it
  (trust-on-first-use).
- If a message can't be verified, or if someone's signing key suddenly changes,
  Vanish shows a warning (“Unverified” / “Key changed”). Take those seriously —
  a key change can be an innocent new device, or it can be someone trying to
  impersonate a member.

## The safety number

Each room has a **safety number** — a short fingerprint of the room's key. If
you and a contact compare safety numbers out-of-band (read them aloud in person
or over another trusted channel) and they match, you can be confident you're in
the same room with the same key and nobody has slipped a different key in
between.

- Compare safety numbers when it really matters.
- If they don't match, stop sharing anything sensitive and re-check how the
  invite link was shared.

## Quick checklist

- [ ] I shared the invite link only with people I trust, over a trusted channel.
- [ ] I'm relying on signing/verification — not just display names — to know who
      said what.
- [ ] I paid attention to any “Unverified” or “Key changed” warnings.
- [ ] For anything sensitive, I compared the safety number out-of-band.

## What Vanish can't protect against

- A person you invited choosing to screenshot, copy, or leak the conversation.
- A compromised device or browser (malware, a hostile extension, or someone
  with your unlocked device can read messages).
- Network metadata: *that* you're using Vanish, *when*, and roughly how much
  traffic you send remain observable.

For the full technical threat model, see the **Threat model** section of the
project [README](../README.md).
