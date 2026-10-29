describe('login', () => {
  it('renamed text', () => {
    cy.visit('/');
    cy.contains('button', 'Logn').click();
  });
});
