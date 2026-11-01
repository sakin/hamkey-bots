<script lang="ts">
	import { onMount, tick } from "svelte";
	import { devMember, fetchMe, followThread, sendMessage, setDevMember, type Me, type ThreadView } from "./api.ts";

	let me = $state<Me | undefined>();
	let refused = $state(false);
	let view = $state<ThreadView>({ messages: [], busy: false });
	let online = $state(true);
	let text = $state("");
	let sending = $state(false);
	let scroller: HTMLElement | undefined = $state();

	async function load() {
		me = await fetchMe();
		refused = me === undefined;
	}

	onMount(() => {
		load();
		const stop = followThread(
			(v) => (view = v),
			(o) => (online = o),
		);
		return stop;
	});

	$effect(() => {
		view.messages.length;
		view.draft;
		tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const message = text.trim();
		if (!message || sending) return;
		sending = true;
		if (await sendMessage(message)) text = "";
		sending = false;
	}

	function onKey(event: KeyboardEvent) {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			(event.currentTarget as HTMLElement).closest("form")?.requestSubmit();
		}
	}

	function pickDev(id: string) {
		setDevMember(id);
		location.reload();
	}
</script>

<div class="mx-auto flex h-full max-w-2xl flex-col bg-white shadow-sm md:my-0 md:border-x md:border-gray-200">
	<header class="flex items-center justify-between border-b border-gray-200 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
		<div>
			<h1 class="text-base font-semibold">{me?.bot.name ?? "Hamkey"}</h1>
			{#if me}<p class="text-xs text-gray-500">Private to {me.member.name}</p>{/if}
		</div>
		<div class="flex items-center gap-2">
			{#if !online}<span class="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Reconnecting…</span>{/if}
			{#if import.meta.env.DEV}
				<select
					class="rounded border border-gray-300 text-xs"
					aria-label="Act as (development)"
					value={devMember() ?? ""}
					onchange={(e) => pickDev(e.currentTarget.value)}
				>
					<option value="">default</option>
					{#each ["ann", "ben"] as id}<option value={id}>{id}</option>{/each}
				</select>
			{/if}
		</div>
	</header>

	{#if refused}
		<main class="flex flex-1 items-center justify-center p-6 text-center text-gray-600">
			<p>Hamkey doesn't recognise this device. Open it from a Tailscale account that belongs to the household.</p>
		</main>
	{:else}
		<main bind:this={scroller} class="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
			{#if view.messages.length === 0 && !view.draft}
				<p class="pt-8 text-center text-sm text-gray-400">Say hello to start the conversation.</p>
			{/if}
			{#each view.messages as message (message.id)}
				<div class="flex {message.role === 'user' ? 'justify-end' : 'justify-start'}">
					<p
						class="max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed {message.role === 'user'
							? 'bg-gray-900 text-white'
							: 'bg-gray-100 text-gray-900'}"
					>
						{message.text}
					</p>
				</div>
			{/each}
			{#if view.busy}
				<div class="flex justify-start">
					<p class="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-gray-100 px-3.5 py-2 text-sm leading-relaxed text-gray-900">
						{view.draft ?? "…"}
					</p>
				</div>
			{/if}
			{#if view.error}<p class="text-center text-sm text-red-600" role="alert">{view.error}</p>{/if}
		</main>

		<form
			onsubmit={submit}
			class="flex items-end gap-2 border-t border-gray-200 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
		>
			<textarea
				bind:value={text}
				onkeydown={onKey}
				rows="1"
				placeholder="Message your Primary Bot"
				aria-label="Message"
				class="max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-gray-300 px-3 py-2.5 text-base focus:border-gray-900 focus:outline-none"
			></textarea>
			<button
				type="submit"
				disabled={sending || !text.trim()}
				class="h-11 rounded-xl bg-gray-900 px-4 text-sm font-medium text-white disabled:opacity-40"
			>
				Send
			</button>
		</form>
	{/if}
</div>
