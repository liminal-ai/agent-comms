/srv/agents/hazel/bin/h0-term TERM-1 270 "$(/srv/agents/hazel/bin/h0-prompt TERM-1 150 "with default settings: don't set a timeout and don't run it in the background")"
/srv/agents/hazel/bin/h0-term TERM-2 260 "$(/srv/agents/hazel/bin/h0-prompt TERM-2 150 "in the foreground with the timeout set to 300000 ms (5 minutes)")"
/srv/agents/hazel/bin/h0-term TERM-3 760 "$(/srv/agents/hazel/bin/h0-prompt TERM-3 660 "in the foreground with the timeout set to 900000 ms (15 minutes)")"
