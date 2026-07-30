const mockAnthropicMessageCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicMessageCreate },
})));

const {
  _resetMappingCache,
  proposeColumnMapping,
} = require('../../src/services/anthropic.service');

describe('AI column-mapping privacy controls', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockAnthropicMessageCreate.mockReset();
    _resetMappingCache();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('does not call a provider when the user cannot spend credits', async () => {
    const result = await proposeColumnMapping(
      ['Date', 'Item', 'Total'],
      [{ Date: '2026-01-01', Item: 'Flat White', Total: '45.00' }],
      { allowPaidAi: false }
    );

    expect(result).toEqual(expect.objectContaining({
      mapping: {},
      aiCreditsCharged: 0,
      aiUnavailableReason: 'permission_required',
    }));
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
  });

  it('keeps likely headerless customer identifiers away from the provider', async () => {
    const result = await proposeColumnMapping(
      ['alice.private@example.com', 'Flat White', '45.00'],
      [],
      {}
    );

    expect(result).toEqual(expect.objectContaining({
      mapping: {},
      aiCreditsCharged: 0,
      aiUnavailableReason: 'sensitive_headers',
    }));
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
  });

  it('sends only value shapes and suppresses customer-field samples', async () => {
    mockAnthropicMessageCreate.mockResolvedValue({
      id: 'mapping-request',
      model: 'test-model',
      usage: { input_tokens: 40, output_tokens: 15 },
      content: [{
        type: 'text',
        text: JSON.stringify({
          mapping: {
            date: 'Date',
            items: 'Item',
            total: 'Total',
          },
          itemsMode: 'packed',
        }),
      }],
    });

    const result = await proposeColumnMapping(
      ['Date', 'Item', 'Total', 'Customer Email'],
      [{
        Date: '2026-01-01',
        Item: 'ZeldaPrivateDrink',
        Total: '45.00',
        'Customer Email': 'zelda.private@example.com',
      }],
      {}
    );

    expect(result.mapping).toEqual({
      date: 'Date',
      items: 'Item',
      total: 'Total',
    });
    const request = mockAnthropicMessageCreate.mock.calls[0][0];
    const prompt = request.messages[0].content;
    expect(prompt).not.toContain('ZeldaPrivateDrink');
    expect(prompt).not.toContain('zelda.private@example.com');
    expect(prompt).toContain('"suppressed": true');
    expect(prompt).toContain('"kind": "text"');
  });
});
