# Publishing checklist (waiting for Ahmed's approval: nothing here has been run)

- **Name:** `groundwork` (account Farouk1901, so `github.com/Farouk1901/groundwork`)
- **Description:** Before the first line of code: the files, people and risks of a ticket, from how similar tickets were fixed. Hybrid search + graph paths in Relate (Neo4j). CLI, MCP server, web view.
- **Topics:** `relate`, `relate-neo4j-hackathon`, `neo4j`, `mcp`, `coding-agents`, `graph`, `hybrid-search`, `developer-tools`
- **License:** MIT (the LICENSE file is in the repo)

The commands, run only after approval:

```bash
gh repo create Farouk1901/groundwork --public --source . --push --description "Before the first line of code: the files, people and risks of a ticket, from how similar tickets were fixed. Hybrid search + graph paths in Relate (Neo4j). CLI, MCP server, web view."
gh repo edit Farouk1901/groundwork --add-topic relate --add-topic relate-neo4j-hackathon --add-topic neo4j --add-topic mcp --add-topic coding-agents --add-topic graph --add-topic hybrid-search --add-topic developer-tools
```

Check before going public:
1. `git log` has only the author `Ahmed Farouk <Farouk1901@users.noreply.github.com>`.
2. Nothing secret in the files: `.groundwork/` (the cache and the graph) is in `.gitignore`.
3. After pushing, open the repo page and confirm the `relate` topic shows up.
