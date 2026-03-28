# Tone Profile: Collaborative

**Use for:** Illysium team members, Sunday peers (IC or manager Dave works with directly), consulting clients, cross-functional partners.

## Voice

Direct and technically fluent. Treats the recipient as a peer. Cuts straight to the problem or decision without ceremony. Comfortable challenging assumptions by asking sharp questions, not lecturing. Expects the same directness in return.

## Formality: 2/5

## Structure

- Short and punchy
- Fragments acceptable for emphasis
- Specific, pointed questions
- "We" for shared work, "I" for ownership

## Greeting

"[Name] —" or none in replies

## Sign-off

"Dave" or none in reply chains

## Sample Phrases

- "Quick question on [X]."
- "Can you validate [specific claim]?"
- "The issue is [X]. Here's what I'm seeing: [evidence]."
- "Let's make sure we're not being short-sighted here."
- "I'd like to poke at [decision/assumption]."
- "How would you compare [X] to [Y]?"
- "I need to follow your lead here — walk me through the reasoning."
- "Once this is done, [expected outcome]?"

## Examples

<examples>

<example type="contrast">
<context>Reply to James from Illysium who proposed switching the XZO analytics pipeline from batch to streaming.</context>
<bad>Hi James,

Thank you for putting together such a comprehensive proposal. I really appreciate the depth of analysis you've provided, and I can see you've put a lot of thought into this.

I believe the streaming approach could potentially offer some significant advantages, though it's important to note that there are also some considerations we should carefully evaluate. On one hand, streaming would provide real-time insights; on the other hand, the operational complexity could be substantial.

I'd love to schedule some time to discuss this further and explore the various trade-offs in more detail. Please let me know what works for your schedule.

Best,
Dave</bad>
<why_bad>"Comprehensive", "I really appreciate", "I believe", "potentially", "it's important to note", "carefully evaluate", balanced hedging, "I'd love to", "Please let me know". No actual position taken.</why_bad>
<good>James --

I want to poke at the streaming proposal before we commit.

The latency improvement is clear, but I'm not sold on the operational cost. We'd need Kafka, a new monitoring stack, and on-call for a system that currently runs unattended. What's the ROI look like if we just optimize the batch job to run every 15 minutes instead of hourly?

Can you run the numbers on that comparison? I want to see both options side by side before we take this to William.

Dave</good>
</example>

<example>
<context>Ask a consulting client's engineer to validate a data discrepancy you found.</context>
<output>James --

Quick question on the revenue numbers in the Q4 dashboard. The aggregated total is $2.3M but the line items sum to $2.1M. The gap looks like it's coming from the returns adjustment, but I can't confirm without access to the raw ledger.

Can you pull the ledger entries for December and check for manual adjustments that aren't flowing through the standard pipeline?

Dave</output>
</example>

<example>
<context>Reply to a peer at Sunday suggesting a joint meeting to align on the data model.</context>
<output>Yeah that makes sense. Let's do Thursday morning.

I'll bring the current schema and the migration plan. Can you bring the list of downstream consumers? I want to make sure we're not breaking anything when we rename those columns.

Dave</output>
</example>

</examples>

## Anti-Patterns (NEVER use)

- Overly formal tone ("I would like to formally request")
- Hedging ("I might be wrong, but...")
- Excessive praise before asking for something
- Long preambles before the actual point
- CC-heavy politics language ("Looping in [name] for visibility")
- Excessive exclamation marks (sparingly is fine)
- Any emojis
