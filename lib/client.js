window.__ModuleLoader__.load({
	id: "dsh-file-explorer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const { jsx } = require("react/jsx-runtime");

		/** Port served by lib/index.js; keep both in sync. */
		const TREE_URL = "http://127.0.0.1:8910/";

		const en = {
			panel: "Files",
			treeTitle: "Files",
			treeDesc: "Remote directory tree"
		};
		const zh = {
			panel: "文件",
			treeTitle: "文件树",
			treeDesc: "远程目录树"
		};

		const frameStyle = {
			display: "block",
			width: "100%",
			height: "100%",
			border: 0,
			background: "#fff",
			colorScheme: "light"
		};

		/** Left-rail glyph. */
		function FolderIcon({ size }) {
			const dimension = size || 16;
			return jsx("svg", {
				width: dimension,
				height: dimension,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: jsx("path", {
					d: "M1.75 4.5A1.75 1.75 0 0 1 3.5 2.75h2.6c.36 0 .7.11.98.32l1.2.9h4.22A1.75 1.75 0 0 1 14.25 5.7v5.8a1.75 1.75 0 0 1-1.75 1.75h-9A1.75 1.75 0 0 1 1.75 11.5v-7Z",
					stroke: "currentColor",
					"stroke-width": "1.2",
					"stroke-linejoin": "round"
				})
			});
		}

		/** Main-area page: the whole tree, edge to edge. */
		function ExplorerPanel() {
			return jsx("iframe", {
				src: TREE_URL,
				title: "files",
				allow: "clipboard-write; clipboard-read",
				sandbox: "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox",
				style: frameStyle
			});
		}

		/** The same page inside a right-sidebar tab, so it can sit beside a conversation. */
		function TreeTab() {
			return jsx("iframe", {
				src: TREE_URL,
				title: "files",
				allow: "clipboard-write; clipboard-read",
				sandbox: "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox",
				style: frameStyle
			});
		}

		/** Services this browser plugin needs from the client kernel. */
		const inject = ["slots", "locale", "sidebarRightTabs"];

		/**
		 * Register three surfaces backed by one page: a left-rail entry, the
		 * main-area page it selects, and a right-dock tab type that survives
		 * session switches.
		 * @param ctx - Browser context with slot, locale and tab-registry services.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register("fileExplorer", { en, zh }));
			const t = ctx.locale.bind("fileExplorer");

			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: "file-explorer",
				order: 30,
				locale: "fileExplorer",
				label: () => t("panel")
			}, FolderIcon));

			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: "file-explorer",
				locale: "fileExplorer"
			}, ExplorerPanel));

			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: "dsh-file-explorer/tree",
				kind: "file-tree",
				priority: "builtin",
				keepMounted: true,
				title: () => t("treeTitle"),
				guide: [{
					id: "tree",
					order: 15,
					title: () => t("treeTitle"),
					description: () => t("treeDesc")
				}]
			}), "file-explorer: tab type");

			ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: "dsh-file-explorer/tree",
				locale: "fileExplorer"
			}, TreeTab));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
