# The Research Bot holds all web access

Only the Research Bot has web tools, and it has no access to personal memory. Other Bots, including Primary Bots, use a research tool that sends it a request and gets text back, each in a fresh conversation. It can search and open links from its search results, but never a URL another Bot supplies, its output is marked untrusted, and it cannot call other Bots. Members can also talk to it directly, each in their own private thread.

Research sits behind a Bot, not directly in each Bot's tools, because web pages then reach a separate model with no private data, and only its summary reaches the caller. Giving every Bot web tools was rejected for that reason, and limiting web tools to Household Bots was rejected because Primary Bots need to look things up. A Primary Bot could still put private details in a request, and only its instructions prevent that.
