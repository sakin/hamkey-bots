<script lang="ts">
	import { onMount } from "svelte";
	import { fetchExposure, saveExposure, type ExposureView } from "./api.ts";

	let { ondone }: { ondone: () => void } = $props();

	let view = $state<ExposureView | undefined>();
	let loading = $state(true);
	let failed = $state(false);
	let saving = $state(false);
	let saved = $state(false);
	let error = $state<string | undefined>();
	/** Topic id to the Bot ids ticked now. */
	let chosen = $state<Record<string, string[]>>({});

	onMount(async () => {
		view = await fetchExposure();
		if (view === undefined) failed = true;
		else chosen = Object.fromEntries(view.topics.map((t) => [t.id, [...(view!.exposure[t.id] ?? [])]]));
		loading = false;
	});

	function toggle(topic: string, bot: string, on: boolean) {
		saved = false;
		const rest = (chosen[topic] ?? []).filter((b) => b !== bot);
		chosen[topic] = on ? [...rest, bot] : rest;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (saving) return;
		saving = true;
		error = undefined;
		const result = await saveExposure($state.snapshot(chosen));
		saving = false;
		if ("error" in result) error = result.error;
		else saved = true;
	}
</script>

<form onsubmit={submit} class="flex-1 space-y-4 overflow-y-auto px-4 py-4">
	<h2 class="text-base font-semibold">What other Bots may ask about you</h2>
	<p class="text-sm text-gray-600">
		When a Bot needs to know something about you, it asks your Primary Bot. Pick which Bots may ask about each Topic. An Ask is answered only from the facts you
		approved for that Topic, and never from anything else you have told a Bot. Nothing is allowed until you tick it, and a change applies to the next Ask.
	</p>
	<p class="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="note">
		Hamkey keeps your data on a server that one of you runs. That person, the Operator, can read it there. Both of you are told this: what you share and
		keep private is protected from Bots and from each other in the app, not from the Operator.
	</p>
	{#if loading}
		<p class="text-sm text-gray-500">Loading…</p>
	{:else if failed || view === undefined}
		<p class="text-sm text-red-600" role="alert">Could not load your list. Go back and try again.</p>
	{:else}
		{#each view.topics as topic (topic.id)}
			<fieldset class="text-sm">
				<legend class="font-medium">{topic.label}</legend>
				{#each view.bots as bot (bot.id)}
					<label class="mt-1 flex items-center gap-2 font-normal">
						<input
								type="checkbox"
								aria-label="Let {bot.name} ask about {topic.label}"
								checked={(chosen[topic.id] ?? []).includes(bot.id)} onchange={(e) => toggle(topic.id, bot.id, e.currentTarget.checked)} />
						{bot.name}
						<span class="text-xs text-gray-500">{bot.kind === "household" ? "household" : "common"}</span>
					</label>
				{:else}
					<p class="mt-1 text-xs text-gray-500">There are no Household or Common Bots yet.</p>
				{/each}
			</fieldset>
		{/each}
		{#if error}<p class="text-sm text-red-600" role="alert">{error}</p>{/if}
		{#if saved}<p class="text-sm text-emerald-700" role="status">Saved. It applies from the next Ask.</p>{/if}
	{/if}
	<div class="flex gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
		<button type="button" onclick={ondone} class="h-11 flex-1 rounded-xl border border-gray-300 text-sm font-medium">Back</button>
		<button type="submit" disabled={saving || loading || failed} class="h-11 flex-1 rounded-xl bg-gray-900 text-sm font-medium text-white disabled:opacity-40">
			{saving ? "Saving…" : "Save"}
		</button>
	</div>
</form>
