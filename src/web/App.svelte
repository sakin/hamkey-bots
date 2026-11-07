<script lang="ts">
	import { onMount, tick } from "svelte";
	import BotEditor from "./BotEditor.svelte";
	import { devMember, fetchBots, fetchMe, followThread, sendMessage, setDevMember, type BotDefinition, type BotSummary, type Me, type ThreadView } from "./api.ts";

	let me = $state<Me | undefined>();
	let refused = $state(false);
	let view = $state<ThreadView>({ messages: [], busy: false });
	let bots = $state<BotSummary[]>([]);
	let botsFailed = $state(false);
	let botId = $state<string | undefined>();
	let online = $state(true);
	let text = $state("");
	let sending = $state(false);
	/** Why the last message could not be sent, such as the daily spend limit. */
	let sendError = $state<string | undefined>();
	/** What the form is doing: nothing, creating a Bot, or editing the current one. */
	let editing = $state<"create" | "edit" | undefined>();
	let scroller: HTMLElement | undefined = $state();

	const bot = $derived(bots.find((b) => b.id === botId));

	async function load() {
		me = await fetchMe();
		refused = me === undefined;
		if (refused) return;
		const found = await fetchBots();
		botsFailed = found === undefined;
		bots = found ?? [];
		botId = bots[0]?.id;
	}

	async function saved(saved: BotDefinition) {
		editing = undefined;
		const found = await fetchBots();
		if (found !== undefined) bots = found;
		botId = saved.id;
	}

	onMount(() => {
		load();
	});

	// Switching Bots follows that Bot's thread; the server keeps each one, so nothing is lost by leaving.
	$effect(() => {
		const id = botId;
		if (id === undefined) return;
		view = { messages: [], busy: false };
		online = true;
		text = "";
		sendError = undefined;
		return followThread(
			id,
			(v) => (view = v),
			(o) => (online = o),
		);
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
		if (botId !== undefined) {
			sendError = await sendMessage(botId, message);
			if (sendError === undefined) text = "";
		}
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
			<h1 class="text-base font-semibold">
				{bot?.name ?? "Hamkey"}
				{#if bot?.shared}<span class="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 align-middle text-xs font-medium text-emerald-800">Shared</span>{/if}
			</h1>
			{#if me && bot}<p class="text-xs text-gray-500">
					{bot.shared ? "Shared thread: both of you write here" : bot.kind === "common" ? `Private to ${me.member.name}, one Bot for both` : `Private to ${me.member.name}`}
				</p>{/if}
		</div>
		<div class="flex items-center gap-2">
			{#if !online}<span class="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Reconnecting…</span>{/if}
			{#if bot?.editable && !editing}
				<button type="button" onclick={() => (editing = "edit")} class="rounded border border-gray-300 px-2 py-1 text-xs">Edit</button>
			{/if}
			{#if import.meta.env.DEV}
				<select
					class="rounded border border-gray-300 text-xs"
					aria-label="Act as (development)"
					value={devMember() ?? ""}
					onchange={(e) => pickDev(e.currentTarget.value)}
				>
					<option value="">default</option>
					{#each me?.devMembers ?? [] as id}<option value={id}>{id}</option>{/each}
				</select>
			{/if}
		</div>
	</header>

	{#if refused}
		<main class="flex flex-1 items-center justify-center p-6 text-center text-gray-600">
			<p>Hamkey doesn't recognise this device. Open it from a Tailscale account that belongs to the household.</p>
		</main>
	{:else}
		<nav class="flex gap-2 overflow-x-auto border-b border-gray-200 px-3 py-2" aria-label="Bots">
			{#each bots as b (b.id)}
				<button
					type="button"
					onclick={() => (botId = b.id)}
					aria-current={b.id === botId ? "true" : undefined}
					class="shrink-0 rounded-full border px-3 py-1.5 text-sm {b.id === botId ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 text-gray-700'}"
				>
					{b.name}
					<span class="text-xs opacity-70">{b.shared ? "shared" : b.kind}</span>
				</button>
			{/each}
			<button
				type="button"
				onclick={() => (editing = "create")}
				aria-label="Create a Bot"
				class="shrink-0 rounded-full border border-dashed border-gray-400 px-3 py-1.5 text-sm text-gray-700"
			>
				+ New
			</button>
		</nav>
		{#if bot?.warning}
			<p class="bg-amber-50 px-4 py-2 text-center text-sm text-amber-800" role="status">{bot.warning}</p>
		{/if}
		{#if botsFailed}
			<p class="px-4 py-2 text-center text-sm text-red-600" role="alert">Could not load your Bots. Reload to try again.</p>
		{/if}
		{#if editing}
			{#key `${editing}:${botId}`}
				<BotEditor botId={editing === "edit" ? botId : undefined} onsaved={saved} oncancel={() => (editing = undefined)} />
			{/key}
		{:else}
		<main bind:this={scroller} class="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
			{#if view.messages.length === 0 && !view.draft}
				<p class="pt-8 text-center text-sm text-gray-400">Say hello to start the conversation.</p>
			{/if}
			{#each view.messages as message (message.id)}
				<!-- In a shared thread the other Member's messages are not mine, so the side follows the sender. -->
				{@const mine = message.role === "user" && (message.sender === undefined || message.sender.id === me?.member.id)}
				<div class="flex flex-col {mine ? 'items-end' : 'items-start'}">
					{#if bot?.shared && message.sender}<span class="mb-0.5 px-1 text-xs text-gray-500">{message.sender.name}</span>{/if}
					<p
						class="max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed {mine
							? 'bg-gray-900 text-white'
							: message.role === 'user'
								? 'bg-emerald-100 text-gray-900'
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
			{#if sendError}<p class="text-center text-sm text-red-600" role="alert">{sendError}</p>{/if}
		</main>

		<form
			onsubmit={submit}
			class="flex items-end gap-2 border-t border-gray-200 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
		>
			<textarea
				bind:value={text}
				onkeydown={onKey}
				rows="1"
				placeholder={bot ? `Message ${bot.name}` : "Message"}
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
	{/if}
</div>
