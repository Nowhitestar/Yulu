# Separate provider authorization from data disclosure

Yulu treats permission to invoke a provider and the user's understanding of its
data path as separate decisions. Before first use, each selected cloud-backed
capability discloses whether it sends audio or transcript text and to which
service, records the disclosure version, and asks again only after a material
change. A provider's OAuth session or API key proves authorization but never
stands in for this disclosure; genuinely local processing is identified as
local instead.
