
## 2026-07-30T12:08:18Z — first real verdict (n>=200 both models)

opus-5-low  n=480  mean=840  median=652  p90=1816  total=403243
sonnet-5    (14d)  mean=444  median=279  p90=987
sonnet-5    (4 densest days, n=2347)  weighted mean=535

Headline the script prints: +89.3% vs the 14-day sonnet mean.
Like-for-like against sonnet's DENSE days: +57.0%.

CONFOUND, and it is large enough that neither number should be quoted alone:
- All 480 opus turns come from ONE session (02:54Z onward) — an atypically deep
  multi-agent debugging night with very long bus messages.
- The sonnet 444 spans 14 days of MIXED workload including routine acks.
- So the raw comparison is Opus-on-a-hard-night vs Sonnet-on-two-typical-weeks.
- The 535 dense-day figure is the closest available like-for-like, and +57% is the
  more defensible number.
- A large share of the 840 is seb_boss's own choice to write 400-600 word bus
  messages, which is a behaviour, not a model property. Not separable from this data.

DIRECTION SO FAR: Opus-5 at low effort is spending MORE output tokens per turn than
Sonnet-5, not fewer. That is the opposite of the claim the test was set up to check.
One night, one workload, one confounded comparison. Not a conclusion.
