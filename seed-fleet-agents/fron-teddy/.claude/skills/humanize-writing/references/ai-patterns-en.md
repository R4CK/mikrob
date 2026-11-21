# EN AI-patterns -- word list for i18n source text

Use this list when humanizing EN source strings before handing them to translators.

## Filler / hedge words (delete or replace with concrete content)

```
undoubtedly, certainly, definitely, of course
it is important to note, it should be noted, it is worth noting
needless to say, it goes without saying
various, numerous, several (if not followed by a list)
significant, substantial, considerable (without a number)
greatly, significantly, considerably, dramatically
optimal, ideal (without a metric)
holistic, synergistic, paradigm
leverage, utilize (use "use")
empower (use the actual action)
seamless, robust, cutting-edge, best-in-class, world-class
```

## Chatbot remnants (delete)

```
Sure!
Of course!
Certainly!
Absolutely!
Great question!
Happy to help!
I hope this helps!
Feel free to reach out if you need anything!
Let me know if you have any questions!
```

## not-X-but-Y patterns (remove unless genuinely contrasted)

```
Not just a tool, but a partner.
Not software, but a solution.
Not a product, but a movement.
More than an app -- a community.
```

Replace with: what it actually does that others don't.

## Stacked hedging (simplify to one marker)

```
It might potentially perhaps be worth considering
This could possibly be one of the approaches that might work
It may be the case that, in some situations, there could be
```

## Passive / subjectless (activate)

| Passive | Active |
|---|---|
| It can be seen that... | The data shows... |
| It is recommended to... | We recommend... / Do this: |
| It should be noted that... | Note: |
| This is considered to be... | This is... |
| Steps need to be taken... | Take these steps: |

## Anonymous authority (name or remove)

```
Experts say...
Research shows...
Studies suggest...
According to industry analysts...
Data indicates...
```

Replace with: "According to [Source], [Year]..." or remove if unverifiable.

## Deep / profound sentences (delete or concretize)

```
At the end of the day, it's all about people.
Success comes from taking small steps every day.
The future belongs to those who dare.
It's not about the destination, it's about the journey.
In today's fast-paced world, ...
```

## Header repetition (delete the first sentence if it paraphrases the header)

| Header | Repetitive opener (delete) |
|---|---|
| How to Get Started | Getting started is easy. |
| Why Choose Us? | There are many reasons to choose us. |
| Key Results | The following results were observed. |

## Lead-up / throat-clearing (cut)

Any introductory sentence that doesn't add new information. Test: "Would the reader lose anything if I removed this sentence?" If no, cut it.

## Decorative bold / headers (remove)

Bold is for **key terms** or **critical warnings** only. If every third sentence has bold, none of them is emphasized. A header is for section breaks, not sentence-level decoration.

## Knowledge boundary disclaimers (remove if unnecessary)

Remove when the text doesn't promise something it can't deliver:
```
As an AI, I cannot...
My training data only goes up to...
I don't have access to real-time information... (if not relevant)
```

Keep only when the limitation is genuinely relevant to what the user asked.
