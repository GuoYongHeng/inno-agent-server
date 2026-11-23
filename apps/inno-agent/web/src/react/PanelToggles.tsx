import { PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";

interface PanelTogglesProps {
	showWorkspaceControl: boolean;
	sidebarCollapsed: boolean;
	workspaceCollapsed: boolean;
	onToggleSidebar: () => void;
	onToggleWorkspace: () => void;
}

/**
 * Floating panel controls overlaid on the app shell: the collapsed-sidebar
 * expand button (the collapsed rail renders nothing itself) and the workspace
 * panel toggle anchored to the header's right edge.
 *
 * The sidebar toggle only renders while the sidebar is collapsed — the
 * expanded sidebar carries its own collapse button inside its header, so no
 * floating control ever overlaps the brand row (reference-app pattern).
 */
export function PanelToggles({
	showWorkspaceControl,
	sidebarCollapsed,
	workspaceCollapsed,
	onToggleSidebar,
	onToggleWorkspace,
}: PanelTogglesProps) {
	return (
		<div className="inno-window-chrome" aria-label="窗口工具栏">
			{sidebarCollapsed ? (
				<div className="inno-window-chrome-bar">
					<button
						type="button"
						className="inno-window-chrome-button"
						title="展开侧栏"
						aria-label="展开侧栏"
						onClick={onToggleSidebar}
					>
						<PanelLeftOpen size={15} />
					</button>
				</div>
			) : null}
			{showWorkspaceControl ? (
				<button
					type="button"
					className="inno-window-chrome-button inno-window-chrome-workspace-button"
					title={workspaceCollapsed ? "打开工作区" : "收起工作区"}
					aria-label={workspaceCollapsed ? "打开工作区" : "收起工作区"}
					aria-pressed={!workspaceCollapsed}
					onClick={onToggleWorkspace}
				>
					{workspaceCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
				</button>
			) : null}
		</div>
	);
}
