<script lang="ts">
	import { onMount } from "svelte";
	import { fetchCatalog, fetchDefinition, saveBot, type BotDefinition, type BotKind, type Catalog } from "./api.ts";

	/** Edit this Bot, or create a new one when absent. */
	let { botId, onsaved, oncancel }: { botId?: string; onsaved: (bot: BotDefinition) => void; oncancel: () => void } = $props();

	let catalog = $state<Catalog | undefined>();
	let loading = $state(true);
	let failed = $state(false);
	let saving = $state(false);
	let error = $state<string | undefined>();
	let name = $state("");
	let instructions = $state("");
	let model = $state("");
	let kind = $state<BotKind>("personal");
	let tools = $state<string[]>([]);

	const kinds: { id: BotKind; label: string; hint: string }[] = [
		{ id: "personal", label: "Personal", hint: "Only you can use it." },
		{ id: "household", label: "Household", hint: "Both of you share one conversation." },
		{ id: "common", label: "Common", hint: "Both of you use it, each in a private conversation." },
	];

	onMount(async () => {
		catalog = await fetchCatalog();
		if (botId !== undefined) {
			const bot = await fetchDefinition(botId);
			if (bot === undefined) failed = true;
			else {
				name = bot.name;
				instructions = bot.instructions;
				model = bot.model ?? "";
				kind = bot.kind;
				tools = [...bot.tools];
			}
		} else {
			tools = [...(catalog?.tools ?? [])];
		}
		failed ||= catalog === undefined;
		loading = false;
	});

	function toggle(tool: string, on: boolean) {
		tools = on ? [...tools, tool] : tools.filter((t) => t !== tool);
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (saving) return;
		saving = true;
		error = undefined;
		const result = await saveBot({ name, instructions, model: model === "" ? null : model, tools, kind }, botId);
		saving = false;
		if ("error" in result) error = result.error;
		else onsaved(result.bot);
	}
</script>

<form onsubmit={submit} class="flex-1 space-y-4 overflow-y-auto px-4 py-4">
	<h2 class="text-base font-semibold">{botId === undefined ? "Create a Bot" : "Edit Bot"}</h2>
	{#if loading}
		<p class="text-sm text-gray-500">Loading…</p>
	{:else if failed}
		<p class="text-sm text-red-600" role="alert">Could not load the form. Go back and try again.</p>
	{:else}
		<label class="block text-sm font-medium">
			Name
			<input bind:value={name} required maxlength="80" class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-base font-normal" />
		</label>

		<label class="block text-sm font-medium">
			Instructions
			<textarea
				bind:value={instructions}
				required
				rows="6"
				class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-base font-normal"
				placeholder="What this Bot is for and how it should behave."
			></textarea>
		</label>

		<label class="block text-sm font-medium">
			Model
			<select bind:value={model} class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-base font-normal">
				<option value="">Default ({catalog?.defaultModel})</option>
				{#each catalog?.models ?? [] as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
			</select>
		</label>

		<fieldset class="text-sm" disabled={botId !== undefined}>
			<legend class="font-medium">Who can use it{botId !== undefined ? " (fixed once created)" : ""}</legend>
			{#each kinds as k (k.id)}
				<label class="mt-1 flex items-start gap-2 font-normal">
					<input type="radio" bind:group={kind} value={k.id} class="mt-1" />
					<span>{k.label}<span class="block text-xs text-gray-500">{k.hint}</span></span>
				</label>
			{/each}
		</fieldset>

		<fieldset class="text-sm">
			<legend class="font-medium">Tools</legend>
			{#each catalog?.tools ?? [] as tool (tool)}
				<label class="mt-1 flex items-center gap-2 font-normal">
					<input type="checkbox" checked={tools.includes(tool)} onchange={(e) => toggle(tool, e.currentTarget.checked)} />
					{tool}
				</label>
			{/each}
		</fieldset>

		{#if error}<p class="text-sm text-red-600" role="alert">{error}</p>{/if}
	{/if}

	<div class="flex gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
		<button type="button" onclick={oncancel} class="h-11 flex-1 rounded-xl border border-gray-300 text-sm font-medium">Cancel</button>
		<button type="submit" disabled={saving || loading || failed} class="h-11 flex-1 rounded-xl bg-gray-900 text-sm font-medium text-white disabled:opacity-40">
			{saving ? "Saving…" : "Save"}
		</button>
	</div>
</form>
