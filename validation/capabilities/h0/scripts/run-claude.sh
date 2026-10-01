/srv/agents/hazel/bin/h0-turn T3C-1 thr-382e76cb-58b5-47f1-99e2-1f61290f8873 "$(/srv/agents/hazel/bin/h0-prompt T3C-1 150 "with default settings: don't set a timeout and don't run it in the background")"
/srv/agents/hazel/bin/h0-turn T3C-2 thr-382e76cb-58b5-47f1-99e2-1f61290f8873 "$(/srv/agents/hazel/bin/h0-prompt T3C-2 150 "in the foreground with the timeout set to 300000 ms (5 minutes)")"
/srv/agents/hazel/bin/h0-turn T3C-3 thr-382e76cb-58b5-47f1-99e2-1f61290f8873 "$(/srv/agents/hazel/bin/h0-prompt T3C-3 660 "in the foreground with the timeout set to 900000 ms (15 minutes)")"
