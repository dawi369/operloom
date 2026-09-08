# Execution deadlines and recovery

The browser, facade, and runtime have different jobs and deadlines:

| Boundary                        | Deadline                                            | Purpose                                                 |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Ordinary browser client request | 15 seconds                                          | Bound interactive API waits                             |
| Ordinary facade request         | 10 seconds                                          | Bound control-plane calls                               |
| Browser workflow request        | 180 seconds by default                              | Allow workflow execution and runner cold start          |
| Facade workflow request         | Pack `maxRunSeconds` + 15 seconds                   | Leave room for execution and terminal persistence       |
| Chat provider stream            | 90 seconds                                          | Abort stalled generation without paid retries           |
| Chat recovery alarm             | 105 seconds                                         | Finalize abandoned chat runs                            |
| Workflow execution              | Pack `maxRunSeconds`                                | Abort cooperative tools and race uncooperative adapters |
| Manual-run recovery alarm       | Pack `maxRunSeconds` + 15 seconds from registration | Mark abandoned runs failed even with cron disabled      |

Workflow execution owns its deadline; a browser disconnect is not cancellation.
Check History before retrying an interrupted request. A stopped Fly runner can
consume part of the execution budget while starting. No transport automatically
replays the workflow. Chat provider retries are disabled; users explicitly choose
whether to retry an empty, failed, or truncated response.

The existing workspace session Durable Object stores manual workflow deadlines
before the run is created. Its alarm finalizes only nonterminal runs through the
existing publication fence. Completed or canceled runs stay terminal, and late
artifacts cannot be published as successful results. Alarms need no cron schedule
or notification delivery. Trigger-driven work keeps its existing lease recovery.

Adapters must honor `AgentExecutionContext.signal`; cancellation cannot forcibly
stop arbitrary third-party code. The runtime races the deadline, fences final
publication, and refuses further context tool/state/event calls after abort.
A provider outage may delay durable cleanup; this is not an availability SLA.
