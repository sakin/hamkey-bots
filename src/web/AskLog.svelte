<script lang="ts">
	import { onMount } from "svelte";
	import { fetchAsks, type AskEntry } from "./api.ts";

	let { ondone }: { ondone: () => void } = $props();

	let asks = $state<AskEntry[]>([]);
	let loading = $state(true);
	let failed = $state(false);

	const RESULT = {
		answered: "Answered",
		refused: "Refused",
		"no-facts": "Nothing shared",
		failed: "Could not answer",
	} as const;

	onMount(async () => {
		const found = await fetchAsks();
		if (found === undefined) failed = true;
		else asks = found;
		loading = false;
	});

	const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
</script>

<div class="flex-1 space-y-4 overflow-y-auto px-4 py-4">
	<h2 class="text-base font-semibold">Ask log</h2>
	<p class="text-sm text-gray-600">
		Every time a Bot asked a Primary Bot about one of you, newest first. You both see all of it, including what was refused and what the Bot asked.
	</p>
	{#if loading}
		<p class="text-sm text-gray-500">Loading…</p>
	{:else if failed}
		<p class="text-sm text-red-600" role="alert">Could not load the log. Go back and try again.</p>
	{:else if asks.length === 0}
		<p class="text-sm text-gray-500">No Bot has asked about anyone yet.</p>
	{:else}
		<ul class="space-y-3">
			{#each asks as ask (ask.id)}
				<li class="space-y-1 rounded-lg border border-gray-200 px-3 py-2 text-sm">
					<p class="text-xs text-gray-500">{when(ask.time)}</p>
					<p><span class="font-medium">{ask.bot}</span> asked about <span class="font-medium">{ask.about ?? "someone unknown"}</span>: {ask.topicLabel}</p>
					<p class="whitespace-pre-wrap text-gray-700">“{ask.question}”</p>
					<p class="text-xs font-medium {ask.outcome === 'answered' ? 'text-emerald-700' : 'text-amber-800'}">{RESULT[ask.outcome]}</p>
					{#if ask.answer}<p class="whitespace-pre-wrap">{ask.answer}</p>{/if}
					{#if ask.reason}<p class="text-gray-600">{ask.reason}</p>{/if}
				</li>
			{/each}
		</ul>
	{/if}
	<div class="pb-[max(0.75rem,env(safe-area-inset-bottom))]">
		<button type="button" onclick={ondone} class="h-11 w-full rounded-xl border border-gray-300 text-sm font-medium">Back</button>
	</div>
</div>
