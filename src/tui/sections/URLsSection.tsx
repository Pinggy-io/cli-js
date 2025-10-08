import React from "react";
import { Box, Text, useInput } from "ink";
import clipboardy from "clipboardy";

interface Props {
	urls: string[];
	currentQrIndex: number;
	width?: string;
}

export const URLsSection = ({ urls, currentQrIndex, width = "60%" }: Props) => {
	const [copiedIndex, setCopiedIndex] = React.useState<number | null>(null);

	useInput((input, key) => {
		// Press 'c' to copy current URL
		if (input === "c" && urls.length > 0) {
			const urlToCopy = urls[currentQrIndex];
			clipboardy.writeSync(urlToCopy);
			setCopiedIndex(currentQrIndex);

			// reset feedback after a second
			setTimeout(() => setCopiedIndex(null), 1000);
		}
	});

	return (<Box flexDirection="column" paddingX={1} alignItems="flex-start" width={width} >
		<Text color="greenBright" bold>
			Public URLs
		</Text>
		{urls.map((url, index) => {
			const isSelected = index === currentQrIndex;
			const isCopied = copiedIndex === index;

			return (
				<Text
					key={url}
					color={
						isCopied
							? "cyanBright"
							: isSelected
								? "yellowBright"
								: "magentaBright"
					}
					bold={isSelected || isCopied}
				>
					{isSelected ? "→ " : "• "}
					{url}
					{isCopied && <Text color="greenBright">  [Copied!]</Text>}
				</Text>
			);
		})}
	</Box>);
};
