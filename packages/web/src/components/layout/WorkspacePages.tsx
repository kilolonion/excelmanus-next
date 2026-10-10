import { useState } from "react";
import { useApp } from "../../store.ts";
import { S, UI } from "../../strings.ts";
import { ChatPanel } from "../ChatPanel.tsx";
import { FileList } from "../FileBrowser.tsx";
import { TeamPanel } from "../TeamPanel.tsx";
import { Button } from "../ui/button.tsx";
import { ListDetailLayout, PageHeader, PageState } from "../ui/page-layout.tsx";
import { useWorkspaceNavigation } from "./WorkspaceNavigation.tsx";

export function FilesPage() {
  const { setView } = useWorkspaceNavigation();
  return (
    <section className="workspace-surface">
      <PageHeader
        title={UI.filesTitle}
        description={UI.filesDescription}
        actions={
          <Button variant="outline" onClick={() => setView("workbench")}>
            {UI.backToWorkspace}
          </Button>
        }
      />
      <FileList variant="page" onOpen={() => setView("workbench")} />
    </section>
  );
}
export function TeamPage() {
  const { setView } = useWorkspaceNavigation();
  const roster = useApp((state) => state.session.roster);
  const [selected, setSelected] = useState(false);
  const hasTeam = Object.values(roster).some((agent) => agent.parentId !== null);
  return (
    <section className="workspace-surface">
      <PageHeader
        title={S.teamView}
        description={UI.teamDescription}
        actions={
          <>
            {selected && (
              <Button variant="ghost" className="md:hidden" onClick={() => setSelected(false)}>
                {UI.backToList}
              </Button>
            )}
            <Button variant="outline" onClick={() => setView("workbench")}>
              {UI.backToWorkspace}
            </Button>
          </>
        }
      />
      {hasTeam ? (
        <ListDetailLayout
          label={S.teamView}
          selected={selected}
          className="team-workspace"
          list={<TeamPanel onSelect={() => setSelected(true)} />}
          detail={<ChatPanel sidebarToggle={false} />}
        />
      ) : (
        <PageState kind="empty" title={UI.noTeam} description={UI.noTeamHint} />
      )}
    </section>
  );
}
